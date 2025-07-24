import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';

interface DcvGatewayStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
  nlbArn: string;
  nlbDnsName: string;
}

export class DcvGatewayStack extends cdk.Stack {
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly targetGroup: elbv2.NetworkTargetGroup;
  public readonly webResourcesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DcvGatewayStackProps) {
    super(scope, id, props);

    // Apply consistent tags
    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');
    cdk.Tags.of(this).add('Service', 'DCV-Gateway');

    // Import VPC and subnets
    const vpc = ec2.Vpc.fromLookup(this, 'DcvGatewayVpc', { vpcId: props.vpcId });
    const azs = cdk.Stack.of(this).availabilityZones;
    const subnets = props.subnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetAttributes(this, `DcvGatewaySubnet${i}`, {
        subnetId: id,
        availabilityZone: azs[i % azs.length],
      })
    );

    // Import NLB
    const nlb = elbv2.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'ImportedNLB', {
      loadBalancerArn: props.nlbArn,
      loadBalancerDnsName: props.nlbDnsName,
      vpc: vpc,
    });

    // Get the latest DCV Gateway AMI from ImageBuilder
    const dcvGatewayAmi = new ec2.LookupMachineImage({
      name: 'DCV-Gateway-AMI-*',
      owners: [this.account],
      filters: {
        'state': ['available'],
        'image-type': ['machine'],
      },
    });

    // Create IAM role for DCV Gateway instances
    const dcvGatewayRole = new iam.Role(this, 'DcvGatewayInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for DCV Gateway instances',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Create S3 private bucket for DCV web resources
    this.webResourcesBucket = new s3.Bucket(this, 'DcvWebResourcesBucket', {
      bucketName: `dcv-web-client-private-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
    });

    // Grant S3 read access to DCV Gateway role
    this.webResourcesBucket.grantRead(dcvGatewayRole);

    // Add custom policy for DCV Gateway operations
    dcvGatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
        'ec2:DescribeInstances',
        'ec2:DescribeTags',
      ],
      resources: ['*'],
    }));

    // Add bucket policy to allow access via VPC endpoints
    const bucketPolicyStatement = new iam.PolicyStatement({
      sid: 'AllowAnonReadFromVPCE',
      effect: iam.Effect.ALLOW,
      principals: [new iam.StarPrincipal()],
      actions: ['s3:GetObject'],
      resources: [`${this.webResourcesBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:SourceVpce': [
            'vpce-00adfd3bb1ddd3b3e',
            'vpce-0ca34d81ba2679378',
            'vpce-0d5b5ce599c738f3f'
          ],
        },
      },
    });
    this.webResourcesBucket.addToResourcePolicy(bucketPolicyStatement);

    // Create security group for DCV Gateway
    const dcvGatewaySg = new ec2.SecurityGroup(this, 'DcvGatewaySecurityGroup', {
      vpc: vpc,
      description: 'Security group for DCV Gateway instances',
      allowAllOutbound: true,
    });

    // Allow DCV Gateway traffic (port 8443 for HTTPS, 8081 for HTTP)
    dcvGatewaySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8443),
      'DCV Gateway HTTPS traffic'
    );

    dcvGatewaySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8090),
      'DCV Gateway HTTP traffic'
    );

    // Allow SSH for management (optional, can be removed for production)
    dcvGatewaySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(22),
      'SSH access for management'
    );

    // Create user data script for DCV Gateway configuration
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'yum update -y',
      
      // Install DCV Connection Gateway
      'echo "Installing DCV Connection Gateway..."',
      'wget -q https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-amzn2-x86_64.tgz',
      'tar -xzf nice-dcv-amzn2-x86_64.tgz',
      'cd nice-dcv-*',
      'yum install -y nice-dcv-connection-gateway-*.rpm',
      
      // Configure DCV Gateway
      'echo "Configuring DCV Gateway..."',
      
      // Download and extract DCV web client to S3 (one-time setup)
      'mkdir -p /tmp/dcvweb && cd /tmp/dcvweb',
      'wget -q https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-amzn2-x86_64.tgz',
      'tar -xzf nice-dcv-amzn2-x86_64.tgz',
      `aws s3 sync $(find . -type d -name "nice-dcv-*" -print -quit)/usr/share/dcv/www s3://${this.webResourcesBucket.bucketName} --region ${this.region} || echo "Web resources already uploaded or upload failed"`,
      
      // Set up DCV Connection Gateway configuration with S3 web resources
      'mkdir -p /etc/dcv-connection-gateway',
      'cat > /etc/dcv-connection-gateway/dcv-connection-gateway.conf << EOF',
      '[gateway]',
      '# HTTP（Web UI 配信用）',
      'web-port = 8090',
      'web-listen-endpoints = ["0.0.0.0:8090"]',
      '',
      '# QUIC/TLS 接続用',
      'quic-listen-endpoints = ["0.0.0.0:8443"]',
      'quic-port = 8443',
      '',
      '[resolver]',
      'url = "http://localhost:8447"',
      '',
      '[web-resources]',
      `url = "https://${this.webResourcesBucket.bucketName}.s3.${this.region}.amazonaws.com"`,
      '',
      '[log]',
      'level = "info"',
      'directory = "/var/log/dcv-connection-gateway"',
      'EOF',
      
      // Create log directory
      'mkdir -p /var/log/dcv-connection-gateway',
      
      // Create Session Resolver
      'cat > /tmp/session_resolver.py << EOF',
      'import http.server',
      'import socketserver',
      'import json',
      'import urllib.parse',
      '',
      'class SessionResolverHandler(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        parsed_path = urllib.parse.urlparse(self.path)',
      '        query_params = urllib.parse.parse_qs(parsed_path.query)',
      '        ',
      '        # Extract session ID from query parameters',
      '        session_id = query_params.get("sessionId", [""])[0]',
      '        ',
      '        # Return session information',
      '        response = {',
      '            "sessionId": session_id,',
      '            "dcvSessionId": session_id,',
      '            "tags": {},',
      '            "type": "CONSOLE"',
      '        }',
      '        ',
      '        self.send_response(200)',
      '        self.send_header("Content-type", "application/json")',
      '        self.end_headers()',
      '        self.wfile.write(json.dumps(response).encode())',
      '',
      '    def log_message(self, format, *args):',
      '        pass  # Suppress default logging',
      '',
      'PORT = 8447',
      'with socketserver.TCPServer(("", PORT), SessionResolverHandler) as httpd:',
      '    print(f"Session Resolver running on port {PORT}")',
      '    httpd.serve_forever()',
      'EOF',
      
      // Start Session Resolver in background
      'nohup python3 /tmp/session_resolver.py > /var/log/session_resolver.log 2>&1 &',
      
      // Wait a moment for Session Resolver to start
      'sleep 2',
      
      // Install DCV Web Viewer for local resources
      'echo "Installing DCV Web Viewer..."',
      'cd /tmp/dcvweb',
      'yum localinstall -y $(find . -name "nice-dcv-web-viewer-*.rpm" -print -quit) || echo "Web viewer installation failed or already installed"',
      
      // Try systemd service first, fallback to manual execution
      'systemctl daemon-reload',
      'systemctl enable dcv-connection-gateway',
      'systemctl restart dcv-connection-gateway',
      'sleep 5',
      
      // Check if systemd service is running, if not start manually
      'if ! systemctl is-active --quiet dcv-connection-gateway; then',
      '  echo "systemd service failed, starting manually..."',
      '  pkill -f dcv-connection-gateway || true',
      '  sleep 2',
      '  nohup /usr/libexec/dcv-connection-gateway/dcv-connection-gateway --config /etc/dcv-connection-gateway/dcv-connection-gateway.conf > /var/log/dcv-connection-gateway/manual.log 2>&1 &',
      '  sleep 5',
      'fi',
      
      // Check if ports are listening
      'echo "Checking port status..."',
      'ss -tulpn | grep -E "8090|8443|8447" || echo "Port check completed"',
      
      // Test S3 connection
      'echo "Testing S3 connection..."',
      `curl -s --connect-timeout 5 https://${this.webResourcesBucket.bucketName}.s3.${this.region}.amazonaws.com/index.html | head -3 || echo "S3 test completed"`,
      
      // Install CloudWatch agent
      'yum install -y amazon-cloudwatch-agent',
      
      // Configure CloudWatch agent
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOF',
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/dcv-connection-gateway/gateway.log",',
      '            "log_group_name": "/aws/ec2/dcv-connection-gateway",',
      '            "log_stream_name": "{instance_id}/gateway.log"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  },',
      '  "metrics": {',
      '    "namespace": "DCV/Gateway",',
      '    "metrics_collected": {',
      '      "cpu": {',
      '        "measurement": ["cpu_usage_idle", "cpu_usage_iowait", "cpu_usage_user", "cpu_usage_system"],',
      '        "metrics_collection_interval": 60',
      '      },',
      '      "disk": {',
      '        "measurement": ["used_percent"],',
      '        "metrics_collection_interval": 60,',
      '        "resources": ["*"]',
      '      },',
      '      "mem": {',
      '        "measurement": ["mem_used_percent"],',
      '        "metrics_collection_interval": 60',
      '      }',
      '    }',
      '  }',
      '}',
      'EOF',
      
      // Start CloudWatch agent
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s',
      
      'echo "DCV Connection Gateway configuration completed"',
      'echo "Web resources configured to use S3 bucket via HTTPS"',
      'echo "DCV Gateway listening on ports 8090 (HTTP) and 8443 (QUIC/TLS)"'
    );

    // Create launch template for DCV Gateway
    const launchTemplate = new ec2.LaunchTemplate(this, 'DcvGatewayLaunchTemplate', {
      launchTemplateName: 'dcv-gateway-launch-template',
      machineImage: dcvGatewayAmi,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.LARGE),
      securityGroup: dcvGatewaySg,
      role: dcvGatewayRole,
      userData: userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      // Enable detailed monitoring
      detailedMonitoring: true,
      // Enable IMDSv2 for security
      requireImdsv2: true,
    });

    // Create Auto Scaling Group for DCV Gateway
    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'DcvGatewayAutoScalingGroup', {
      vpc: vpc,
      vpcSubnets: { subnets: subnets },
      launchTemplate: launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1, // Start with 2 instances for HA
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: cdk.Duration.minutes(5),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
        pauseTime: cdk.Duration.minutes(5),
      }),
    });

    // Create target group for DCV Gateway (HTTPS)
    this.targetGroup = new elbv2.NetworkTargetGroup(this, 'DcvGatewayTargetGroup', {
      vpc: vpc,
      port: 8443, // DCV Gateway HTTPS port
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        port: '8443', // Health check on the same port
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Attach Auto Scaling Group to target group
    this.autoScalingGroup.attachToNetworkTargetGroup(this.targetGroup);

    // Create NLB listener for DCV Gateway traffic
    new elbv2.NetworkListener(this, 'DcvGatewayListener', {
      loadBalancer: nlb,
      port: 8443, // External port for DCV Gateway
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [this.targetGroup],
    });

    // Create HTTP listener for health checks and management
    const httpTargetGroup = new elbv2.NetworkTargetGroup(this, 'DcvGatewayHttpTargetGroup', {
      vpc: vpc,
      port: 8090, // DCV Gateway HTTP port
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        port: '8090', // Use DCV Gateway's standard connection port
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Attach Auto Scaling Group to HTTP target group
    this.autoScalingGroup.attachToNetworkTargetGroup(httpTargetGroup);

    // Create HTTP listener
    new elbv2.NetworkListener(this, 'DcvGatewayHttpListener', {
      loadBalancer: nlb,
      port: 8090, // External HTTP port
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [httpTargetGroup],
    });

    // Store important values in SSM Parameter Store
    new ssm.StringParameter(this, 'DcvGatewayAsgName', {
      parameterName: '/isolated/dcv/gateway/asg/name',
      stringValue: this.autoScalingGroup.autoScalingGroupName,
      description: 'Name of the DCV Gateway Auto Scaling Group',
    });

    new ssm.StringParameter(this, 'DcvGatewayTargetGroupArn', {
      parameterName: '/isolated/dcv/gateway/target-group/arn',
      stringValue: this.targetGroup.targetGroupArn,
      description: 'ARN of the DCV Gateway Target Group',
    });

    new ssm.StringParameter(this, 'DcvGatewaySecurityGroupId', {
      parameterName: '/isolated/dcv/gateway/security-group/id',
      stringValue: dcvGatewaySg.securityGroupId,
      description: 'Security Group ID for DCV Gateway instances',
    });

    new ssm.StringParameter(this, 'DcvWebResourcesBucketName', {
      parameterName: '/isolated/dcv/gateway/web-resources/bucket-name',
      stringValue: this.webResourcesBucket.bucketName,
      description: 'Name of the DCV Web Resources S3 bucket',
    });

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'DcvGatewayAsgNameOutput', {
      value: this.autoScalingGroup.autoScalingGroupName,
      description: 'Name of the DCV Gateway Auto Scaling Group',
      exportName: 'DcvGatewayAsgName',
    });

    new cdk.CfnOutput(this, 'DcvGatewayTargetGroupArnOutput', {
      value: this.targetGroup.targetGroupArn,
      description: 'ARN of the DCV Gateway Target Group',
      exportName: 'DcvGatewayTargetGroupArn',
    });

    new cdk.CfnOutput(this, 'DcvGatewayEndpoint', {
      value: `https://${nlb.loadBalancerDnsName}:8443`,
      description: 'DCV Gateway HTTPS endpoint',
      exportName: 'DcvGatewayEndpoint',
    });

    new cdk.CfnOutput(this, 'DcvWebResourcesBucketNameOutput', {
      value: this.webResourcesBucket.bucketName,
      description: 'Name of the DCV Web Resources S3 bucket',
      exportName: 'DcvWebResourcesBucketName',
    });
  }
}