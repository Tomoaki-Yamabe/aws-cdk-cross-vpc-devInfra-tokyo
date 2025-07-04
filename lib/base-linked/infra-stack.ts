import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { ApiServerUserData } from './apiserver-userdata';

interface LinkedVpcStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
  endpointServiceName: string; 
}

export class LinkedInfraStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly subnets: ec2.ISubnet[];
    public readonly linkednlb: elbv2.INetworkLoadBalancer;
    public readonly nlbDnsName: string;
    public readonly endpointServiceId: string;
    public readonly loadBalancerArn: string;
    public readonly endpointDns: string;

    constructor(scope: Construct, id: string, props: LinkedVpcStackProps) {
      super(scope, id, props);

      cdk.Tags.of(this).add('Project', 'EliteGen2');
      cdk.Tags.of(this).add('Environment', 'Production');
      cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
      cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

      this.vpc = ec2.Vpc.fromLookup(this, 'LinkedVpc', {
        vpcId: props.vpcId,
      });

      const azs = cdk.Stack.of(this).availabilityZones;
      this.subnets = props.subnetIds.map((subnetId, index) =>
        ec2.Subnet.fromSubnetAttributes(this, `LinkedSubnet${index}`, {
          subnetId,
          availabilityZone: azs[index % azs.length],
        })
      );


      // ----------------------- Private Link Attachment ----------------------- //
      // Connection Linked to Isolated VPC endpoint
      const endpointServiceName = ssm.StringParameter.valueForStringParameter(
        this, props.endpointServiceName
      ); 
      const interfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ServiceInterfaceEndpoint', {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointService(endpointServiceName, 80),
        privateDnsEnabled: false,
        subnets: { subnets: this.subnets },
      });
      
      // Allow access Security Group 
      interfaceEndpoint.connections.allowDefaultPortFromAnyIpv4('Allow inbound from VPC');
      // Allow all TCP ports
      interfaceEndpoint.connections.securityGroups.forEach(sg => {
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp(), 'Allow all TCP ports');
      });

      // this.endpointDns = cdk.Fn.select(0, interfaceEndpoint.vpcEndpointDnsEntries); HostedZoneId:Route53で使うようなDNS名が入ってしまうのでだめ
      this.endpointDns = cdk.Fn.select(
        1,
        cdk.Fn.split(
          ':',
          cdk.Fn.select(0, interfaceEndpoint.vpcEndpointDnsEntries)
        )
      );     


      // ----------------------- NLB ----------------------- //
      // 暫定的に既存のLinkedVPC用NLBを使用
      this.linkednlb = elbv2.NetworkLoadBalancer.fromLookup(this, 'ExistingNLB', {
        loadBalancerArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:481393820746:loadbalancer/net/sils-isolated2Linked-NLB-SILS/c06fbee59f0c846e',
      });

      // // create and shared internal NLB
      // this.linkednlb = new elbv2.NetworkLoadBalancer(this, 'LinkedSharedNLB', {
      //   vpc: this.vpc,
      //   internetFacing: false, // internal NLB
      //   vpcSubnets: { subnets: this.subnets }, 
      //   crossZoneEnabled: true,
      // });
      this.nlbDnsName = this.linkednlb.loadBalancerDnsName;
      this.loadBalancerArn = this.linkednlb.loadBalancerArn;

      // ----------------------- Endpoint Service ----------------------- //
      // create Private endpoint service
      // const endpointService = new ec2.CfnVPCEndpointService(this, 'PriLink-EndpointService', {
      //     networkLoadBalancerArns: [this.linkednlb.loadBalancerArn],
      //     acceptanceRequired: false, // auto authentification
      // });
      // this.endpointServiceId = endpointService.ref;

      

      // ------------------------ VPC Endpoints ----------------------- //
      // Create Security Group for VPC endpoints
      // const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      //     vpc: this.vpc,
      //     allowAllOutbound: true,
      //     description: 'Allow ECS tasks to access VPC endpoints',
      // });

      // // Allow access Security Group
      // endpointSecurityGroup.addIngressRule(
      //     ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      //     ec2.Port.allTcp(),
      //     'Allow HTTPS from within the VPC'
      // );

      // this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      //     service: ec2.InterfaceVpcEndpointAwsService.ECR,
      //     privateDnsEnabled: true,
      //     subnets: { subnets: this.subnets },
      //     securityGroups: [endpointSecurityGroup],
      // });


      // ------------------------- Gateway Server ASG ----------------------- //

      // API and Gateway server
      const DEFAULT_PORT = 80;
      const LINKED_PORT  = 8080;

      const asgRole = new iam.Role(this, 'GatewayASGRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      });
      
      asgRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
      asgRole.addManagedPolicy( iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMReadOnlyAccess'));
      asgRole.addToPolicy(new iam.PolicyStatement({
        actions: ["ssm:DescribeParameters"],
        resources: ["*"],
      }));
      
      // Add policy for EC2 tag
      asgRole.addToPolicy(new iam.PolicyStatement({
        actions: ["ec2:DescribeTags"],
        resources: ["*"],
      }));
      
      // Add Policy for cfn-signal
      asgRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          "cloudformation:SignalResource",
          "cloudformation:DescribeStackResource",
          "cloudformation:DescribeStackResources"
        ],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${this.stackName}/*`],
      }));
      
      // Add Policy for cfn-init
      asgRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          "cloudformation:DescribeStackResources",
          "cloudformation:DescribeStackResource"
        ],
        resources: ["*"],
      }));
      
      // Add Policy for CloudWatch Logs
      asgRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ],
        resources: ["*"],
      }));

      const gatewaySecurityGroup = new ec2.SecurityGroup(this, 'GatewaySG', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'Allow traffic on port LINKED_PORT',
      });
      gatewaySecurityGroup.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.allTcp(),
        'Allow internal traffic from NLB'
      );


      // ------------------------- Gateway Server EC2 on ASG ----------------------- //

      const keyPair = ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'tom');

      // Try Use Asset
      const apiServerUserData = new ApiServerUserData(this, 'ApiServerUserData');
      
      // Add get S3 Policy to IAM
      apiServerUserData.grantReadToRole(asgRole);

      const userData = apiServerUserData.userData;

      const launchTemplate = new ec2.LaunchTemplate(this, 'GatewayLaunchTemplate', {
        machineImage: ec2.MachineImage.latestAmazonLinux2(),
        instanceType: new ec2.InstanceType('t3.micro'),
        keyPair,
        role: asgRole,
        securityGroup: gatewaySecurityGroup,
        userData: userData,
      });
      
      // LaunchTemplateのメタデータオプションを設定 CDKのL2
      const cfnLaunchTemplate = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
      cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.MetadataOptions', {
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 2,
        InstanceMetadataTags: 'enabled',
      });

      const asg = new autoscaling.AutoScalingGroup(this, 'GatewayASG', {
        vpc: this.vpc,
        vpcSubnets: { subnets: this.subnets },
        minCapacity: 1,
        maxCapacity: 1,
        desiredCapacity: 1,
        launchTemplate,
        // wait to finirsh cfn-signal
        signals: autoscaling.Signals.waitForAll({
          timeout: cdk.Duration.minutes(15),
          minSuccessPercentage: 100,
        }),
        // Setting lifecycle policy
        updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
          maxBatchSize: 1,
          minInstancesInService: 0,
          pauseTime: cdk.Duration.minutes(15),
          waitOnResourceSignals: true,
          suspendProcesses: [
            autoscaling.ScalingProcess.HEALTH_CHECK,
            autoscaling.ScalingProcess.REPLACE_UNHEALTHY,
            autoscaling.ScalingProcess.AZ_REBALANCE,
            autoscaling.ScalingProcess.ALARM_NOTIFICATION,
            autoscaling.ScalingProcess.SCHEDULED_ACTIONS,
            autoscaling.ScalingProcess.INSTANCE_REFRESH,
          ]
        }),
      });

      // ASGの正しいLogical IDを取得
      const asgResourceLogicalId = (asg.node.defaultChild as cdk.CfnResource).logicalId;
      
      // 環境変数を設定してstart-app.shを実行
      apiServerUserData.setEnvironmentAndExecuteStartApp({
        STACK_NAME: this.stackName,
        AWS_DEFAULT_REGION: this.region,
        ASG_RESOURCE_NAME: asgResourceLogicalId,
      });

      // ----------------------- ProxyサーバーNLBリスナー ----------------------- //
      const PROXY_PORT = 8080;
      
      // ProxyサーバーASG用のターゲットグループを作成
      const proxyTargetGroup = new elbv2.NetworkTargetGroup(this, 'ProxyTargetGroup', {
        vpc: this.vpc,
        port: PROXY_PORT,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.INSTANCE,
        healthCheck: {
          enabled: true,
          protocol: elbv2.Protocol.TCP,
          port: `${PROXY_PORT}`,
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
          interval: cdk.Duration.seconds(30),
        },
      });

      // ASGをターゲットグループに接続
      asg.attachToNetworkTargetGroup(proxyTargetGroup);

      // NLBにProxyサーバー用のリスナーを追加
      const proxyListener = this.linkednlb.addListener('ProxyListener', {
        port: PROXY_PORT,
        protocol: elbv2.Protocol.TCP,
        defaultTargetGroups: [proxyTargetGroup],
      });

      // NLBリスナーの作成を一時的にコメントアウト（既存NLBとの競合回避のため）
      // const gatewayListener = this.linkednlb.addListener('GatewayListener', {
      //   port: DEFAULT_PORT,
      //   protocol: elbv2.Protocol.TCP,
      // });

      // gatewayListener.addTargets('GatewayTargets', {
      //   port: LINKED_PORT,
      //   targets: [asg],
      //   protocol: elbv2.Protocol.TCP,
      //   healthCheck: {
      //     port: 'traffic-port',
      //     protocol: elbv2.Protocol.TCP,
      //   },
      // });


      // ------------------------- OnPrem GitLab ----------------------- //
      // const ONPREM_AS4_GITLAB_IP   = '10.0.0.100';
      // const ONPREM_AS4_GITLAB_PORT = 8443;
      // const AS4_GITLAB_LISTENER_PORT = 60000;

      // const gitlabListener = this.linkednlb.addListener('GitLabListener', {
      //   port: AS4_GITLAB_LISTENER_PORT,
      //   protocol: elbv2.Protocol.TCP,
      // });
      // gitlabListener.addTargets('GitLabTargets', {
      //   port: ONPREM_AS4_GITLAB_PORT,
      //   protocol: elbv2.Protocol.TCP,
      //   targets: [new IpTarget(ONPREM_AS4_GITLAB_IP, ONPREM_AS4_GITLAB_PORT, azs[0])],
      //   healthCheck: {
      //     port: `${ONPREM_AS4_GITLAB_PORT}`,
      //     protocol: elbv2.Protocol.TCP,
      //   },
      // });


      // ------------------------- OnPrem SilverLicense ----------------------- //
      // const ONPREM_SILVER_LICENSE_IP   = '10.0.0.200';
      // const ONPREM_SILVER_LICENSE_PORT = 27000;
      // const SILVER_LICENSE_LISTENER_PORT = 60001;

      // const licenseListener = this.linkednlb.addListener('LicenseListener', {
      //   port: SILVER_LICENSE_LISTENER_PORT,
      //   protocol: elbv2.Protocol.TCP,
      // });
      // licenseListener.addTargets('LicenseTargets', {
      //   port: ONPREM_SILVER_LICENSE_PORT,
      //   protocol: elbv2.Protocol.TCP,
      //   targets: [new IpTarget(ONPREM_SILVER_LICENSE_IP, ONPREM_SILVER_LICENSE_PORT, azs[0])],
      //   healthCheck: {
      //     port: `${ONPREM_SILVER_LICENSE_PORT}`,
      //     protocol: elbv2.Protocol.TCP,
      //   },
      // });

      
      // ----------------------- SSM params ----------------------- //
      [
        ['/linked/infra/vpc/id',this.vpc.vpcId],
        ['/linked/infra/nlb/dns',this.nlbDnsName],
        ['/linked/infra/nlb/arn',this.linkednlb.loadBalancerArn],
        ['/linked/infra/endpoint-service/nlb-dns',this.nlbDnsName],
        ['/linked/infra/proxy/endpoint', `${this.linkednlb.loadBalancerDnsName}:${PROXY_PORT}`],
        ['/linked/infra/proxy/port', `${PROXY_PORT}`],
        ['/linked/infra/privatelink/endpoint', this.endpointDns],
        // OnPremエンドポイントは一時的にコメントアウト（NLBリスナー未作成のため）
        // ['/onprem/as4-gitlab/endpoint', `${this.linkednlb.loadBalancerDnsName}:${AS4_GITLAB_LISTENER_PORT}`],
        // ['/onprem/silver-license/endpoint', `${this.linkednlb.loadBalancerDnsName}:${SILVER_LICENSE_LISTENER_PORT}`],
        // ['/linked/infra/endpoint-service/id',this.endpointServiceId],
        // ['/linked/infra/endpoint-service/name',`com.amazonaws.vpce.${this.region}.${endpointService.ref}`],
        // ['/linked/infra/endpoint-service/endpoint-dns',this.endpointDns],
      ].forEach(([param, val])=>
        new ssm.StringParameter(this,param,{ parameterName:param, stringValue:val })
      );
      
      // ----------------------- Outputs ----------------------- //
      new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName, exportName: 'LinkedNlbDnsName' });
      new cdk.CfnOutput(this, 'ProxyEndpoint', {
        value: `${this.linkednlb.loadBalancerDnsName}:${PROXY_PORT}`,
        exportName: 'LinkedProxyEndpoint',
        description: 'Proxy Server Endpoint (NLB DNS:Port)'
      });
      new cdk.CfnOutput(this, 'PrivateLinkEndpoint', {
        value: this.endpointDns,
        exportName: 'LinkedPrivateLinkEndpoint',
        description: 'PrivateLink VPC Endpoint DNS for Backend Services'
      });
      new cdk.CfnOutput(this, 'LoadBalancerArnOutput', { value: this.linkednlb.loadBalancerArn, exportName: 'LinkedNlbArn' });
    }
}
