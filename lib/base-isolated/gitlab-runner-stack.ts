import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';


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


      // ----------------------- NLB ----------------------- //
      // 暫定的に既存のLinkedVPC用NLBを使用
      this.linkednlb = elbv2.NetworkLoadBalancer.fromLookup(this, 'ExistingNLB', {
        loadBalancerArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:481393820746:loadbalancer/net/sils-isolated2Linked-NLB-SILS/c06fbee59f0c846e',
      });

      this.nlbDnsName = this.linkednlb.loadBalancerDnsName;
      this.loadBalancerArn = this.linkednlb.loadBalancerArn;


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
    }
}
