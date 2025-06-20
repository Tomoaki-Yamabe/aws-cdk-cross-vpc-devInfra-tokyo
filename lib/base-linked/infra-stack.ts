import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { configServerUserData } from './apiserver-userdata';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';

interface LinkedVpcStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
}

export class LinkedInfraStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly subnets: ec2.ISubnet[];
    public readonly linkednlb: elbv2.NetworkLoadBalancer;
    public readonly nlbDnsName: string;
    public readonly endpointServiceId: string;
    public readonly loadBalancerArn: string;
    public readonly endpointDns: string;

    constructor(scope: Construct, id: string, props: LinkedVpcStackProps) {
      super(scope, id, props);

      cdk.Tags.of(this).add('Project', 'EliteGen2');
      cdk.Tags.of(this).add('Environment', 'Production');
      cdk.Tags.of(this).add('OwnedBy', 'SILS');
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
        this, '/isolated/infra/endpoint-service/name'
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
      // create and shared internal NLB
      this.linkednlb = new elbv2.NetworkLoadBalancer(this, 'LinkedSharedNLB', {
          vpc: this.vpc,
          internetFacing: false, // internal NLB
          vpcSubnets: { subnets: [ this.subnets[0] ] },
          crossZoneEnabled: true,
      });
      this.nlbDnsName = this.linkednlb.loadBalancerDnsName;
      this.loadBalancerArn = this.linkednlb.loadBalancerArn;

      // ----------------------- Endpoint Service ----------------------- //
      // create Private endpoint service
      const endpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
          networkLoadBalancerArns: [this.linkednlb.loadBalancerArn],
          acceptanceRequired: false, // auto authentification
      });
      this.endpointServiceId = endpointService.ref;
      

      // ------------------------ VPC Endpoints ----------------------- //
      // Create Security Group for VPC endpoints
      const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
          vpc: this.vpc,
          allowAllOutbound: true,
          description: 'Allow ECS tasks to access VPC endpoints',
      });

      // Allow access Security Group
      endpointSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
          ec2.Port.allTcp(),
          'Allow HTTPS from within the VPC'
      );

      this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
          service: ec2.InterfaceVpcEndpointAwsService.ECR,
          privateDnsEnabled: true,
          subnets: { subnets: this.subnets },
          securityGroups: [endpointSecurityGroup],
      });


      // ------------------------- Gateway ASG ----------------------- //

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

      const keyPair = ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'xils-developper');

      const launchTemplate = new ec2.LaunchTemplate(this, 'GatewayLaunchTemplate', {
        machineImage: ec2.MachineImage.latestAmazonLinux2(),
        instanceType: new ec2.InstanceType('t3.micro'),
        keyPair,
        role: asgRole,
        securityGroup: gatewaySecurityGroup,
        userData: ec2.UserData.custom(configServerUserData),
      });

      const asg = new autoscaling.AutoScalingGroup(this, 'GatewayASG', {
        vpc: this.vpc,
        vpcSubnets: { subnets: this.subnets },
        minCapacity: 1,
        maxCapacity: 1,
        desiredCapacity: 1,
        launchTemplate,
      });

      const gatewayListener = this.linkednlb.addListener('GatewayListener', {
        port: DEFAULT_PORT,
        protocol: elbv2.Protocol.TCP,
      });

      gatewayListener.addTargets('GatewayTargets', {
        port: LINKED_PORT,
        targets: [asg],
        protocol: elbv2.Protocol.TCP,
        healthCheck: {
          port: 'traffic-port',
          protocol: elbv2.Protocol.TCP,
        },
      });


      // ------------------------- OnPrem GitLab ----------------------- //
      const ONPREM_AS4_GITLAB_IP   = '10.0.0.100';
      const ONPREM_AS4_GITLAB_PORT = 8443;
      const AS4_GITLAB_LISTENER_PORT = 60000;

      const gitlabListener = this.linkednlb.addListener('GitLabListener', {
        port: AS4_GITLAB_LISTENER_PORT,
        protocol: elbv2.Protocol.TCP,
      });
      gitlabListener.addTargets('GitLabTargets', {
        port: ONPREM_AS4_GITLAB_PORT,
        protocol: elbv2.Protocol.TCP,
        targets: [new IpTarget(ONPREM_AS4_GITLAB_IP, ONPREM_AS4_GITLAB_PORT, azs[0])],
        healthCheck: {
          port: `${ONPREM_AS4_GITLAB_PORT}`,
          protocol: elbv2.Protocol.TCP,
        },
      });


      // ------------------------- OnPrem SilverLicense ----------------------- //
      const ONPREM_SILVER_LICENSE_IP   = '10.0.0.200';
      const ONPREM_SILVER_LICENSE_PORT = 27000;
      const SILVER_LICENSE_LISTENER_PORT = 27000;

      const licenseListener = this.linkednlb.addListener('LicenseListener', {
        port: SILVER_LICENSE_LISTENER_PORT,
        protocol: elbv2.Protocol.TCP,
      });
      licenseListener.addTargets('LicenseTargets', {
        port: ONPREM_SILVER_LICENSE_PORT,
        protocol: elbv2.Protocol.TCP,
        targets: [new IpTarget(ONPREM_SILVER_LICENSE_IP, ONPREM_SILVER_LICENSE_PORT, azs[0])],
        healthCheck: {
          port: `${ONPREM_SILVER_LICENSE_PORT}`,
          protocol: elbv2.Protocol.TCP,
        },
      });

      
      // ----------------------- SSM params ----------------------- //
      [
        ['/linked/infra/vpc/id',this.vpc.vpcId],
        ['/linked/infra/nlb/dns',this.nlbDnsName],
        ['/linked/infra/nlb/arn',this.linkednlb.loadBalancerArn],
        ['/linked/infra/endpoint-service/id',this.endpointServiceId],
        ['/linked/infra/endpoint-service/name',`com.amazonaws.vpce.${this.region}.${endpointService.ref}`],
        ['/linked/infra/endpoint-service/nlb-dns',this.nlbDnsName],
        ['/linked/infra/endpoint-service/endpoint-dns',this.endpointDns],
        ['/onprem/as4-gitlab/endpoint', `${this.linkednlb.loadBalancerDnsName}:${AS4_GITLAB_LISTENER_PORT}`],
        ['/onprem/silver-license/endpoint', `${this.linkednlb.loadBalancerDnsName}:${SILVER_LICENSE_LISTENER_PORT}`],
      ].forEach(([param, val])=>
        new ssm.StringParameter(this,param,{ parameterName:param, stringValue:val })
      );
      
      // ----------------------- Outputs ----------------------- //
      new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName, exportName: 'LinkedNlbDnsName' });
      new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId, exportName: 'LinkedEndpointServiceId' });
      new cdk.CfnOutput(this, 'LoadBalancerArnOutput', { value: this.linkednlb.loadBalancerArn, exportName: 'LinkedNlbArn' });
      new cdk.CfnOutput(this, 'InterfaceEndpointDns', { value: this.endpointDns });
    }
}
