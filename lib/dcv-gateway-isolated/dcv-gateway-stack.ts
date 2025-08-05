import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ssm from 'aws-cdk-lib/aws-ssm';

interface DcvGatewayStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
  nlbArn: string;
  nlbDnsName: string;
}

export class DcvGatewayStack extends cdk.Stack {
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly targetGroup: elbv2.NetworkTargetGroup;

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

    // Use Amazon Linux 2023 AMI
    const dcvGatewayAmi = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.X86_64,
      userData: ec2.UserData.forLinux()
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

    // Create security group for DCV Gateway
    const dcvGatewaySg = new ec2.SecurityGroup(this, 'DcvGatewaySecurityGroup', {
      vpc: vpc,
      description: 'Security group for DCV Gateway instances',
      allowAllOutbound: true,
    });

    // Allow DCV Gateway traffic (port 8443 for HTTPS/WebSocket)
    dcvGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8443),
      'DCV Gateway/WebSocket'
    );

    // Allow SSH for management
    dcvGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'SSH'
    );

    // Allow Broker internal ports
    dcvGatewaySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcpRange(8445, 8448),
      'Broker internal'
    );

    // Allow DCV QUIC
    dcvGatewaySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.udp(8443),
      'DCV QUIC'
    );

    // Create user data script for DCV Gateway + Session Manager Broker configuration
    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash -xe' });
    userData.addCommands(
      //
      // --- DCV リポジトリ & RPM セット ---
      //
      'yum -y install jq curl unzip',

      'cat >/etc/yum.repos.d/nice-dcv.repo <<EOF',
      '[dcv]',
      'name=NICE DCV packages',
      'baseurl=https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/rhel/9/x86_64/',
      'gpgcheck=0',
      'enabled=1',
      'EOF',

      'yum -y install nice-dcv-session-manager-broker nice-dcv-connection-gateway',
      
      //
      // --- Broker 設定 ---
      //
      "cat >>/etc/dcv-session-manager-broker/session-manager-broker.properties <<'CONF'",
      '# 内部認証サーバを同居',
      'enable-gateway              = true',
      'enable-authorization-server = true',
      'enable-authorization        = true',
      '',
      '# ポート',
      'client-to-broker-connector-https-port  = 8448',
      'gateway-to-broker-connector-https-port = 8447',
      'agent-to-broker-connector-https-port   = 8445',
      '',
      '# クラスタ設定（単一ノード）',
      'broker-to-broker-connection-login = dcvsm-user',
      'broker-to-broker-connection-pass  = dcvsm-pass',
      'broker-to-broker-discovery-addresses = 127.0.0.1:47500',
      'CONF',
      
      //
      // --- Gateway 設定 ---
      //
      "install -d -o dcvcgw -g dcvcgw /etc/dcv-connection-gateway/certs",
      "# 自己署名証明書（テスト用途）",
      'openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -subj "/CN=$(hostname -f)" \\',
      '        -keyout /etc/dcv-connection-gateway/certs/dcv.key \\',
      '        -out  /etc/dcv-connection-gateway/certs/dcv.crt',
      'chmod 600 /etc/dcv-connection-gateway/certs/dcv.key',
      'chown dcvcgw:dcvcgw /etc/dcv-connection-gateway/certs/dcv.*',

      "cat >/etc/dcv-connection-gateway/dcv-connection-gateway.conf <<'GWCONF'",
      '[gateway]',
      'quic-listen-endpoints  = []',
      'web-listen-endpoints   = ["0.0.0.0:8443"]',
      'cert-file      = "/etc/dcv-connection-gateway/certs/dcv.crt"',
      'cert-key-file  = "/etc/dcv-connection-gateway/certs/dcv.key"',
      '',
      '[resolver]',
      'url        = "https://127.0.0.1:8447"',
      'tls-strict = false',
      '',
      '[log]',
      'level = "info"',
      'GWCONF',
      
      //
      // --- サービス起動 ---
      //
      'systemctl enable --now dcv-session-manager-broker dcv-connection-gateway',
      
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
      '          },',
      '          {',
      '            "file_path": "/var/log/dcv-session-manager-broker/broker.log",',
      '            "log_group_name": "/aws/ec2/dcv-session-manager-broker",',
      '            "log_stream_name": "{instance_id}/broker.log"',
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
      
      'echo "DCV Gateway + Session Manager Broker configuration completed"'
    );

    // Create launch template for DCV Gateway
    const launchTemplate = new ec2.LaunchTemplate(this, 'DcvGatewayLaunchTemplate', {
      launchTemplateName: 'dcv-gateway-broker-launch-template',
      machineImage: dcvGatewayAmi,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.LARGE),
      securityGroup: dcvGatewaySg,
      role: dcvGatewayRole,
      userData: userData,
      keyName: 'tom', // Use tom key pair for SSH access
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
      desiredCapacity: 1,
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: cdk.Duration.minutes(10), // Increased grace period for broker startup
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
        pauseTime: cdk.Duration.minutes(10), // Increased pause time
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
      description: 'DCV Gateway + Session Manager Broker HTTPS endpoint',
      exportName: 'DcvGatewayEndpoint',
    });

  }
}