import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { configServerUserData } from './apiserver-userdata';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

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
        // output Endpoint DNS name
        new cdk.CfnOutput(this, 'InterfaceEndpointDns', {
          value: cdk.Fn.select(0, interfaceEndpoint.vpcEndpointDnsEntries),
        });


        // ----------------------- NLB ----------------------- //
        // create and shared internal NLB
        this.linkednlb = new elbv2.NetworkLoadBalancer(this, 'LinkedSharedNLB', {
            vpc: this.vpc,
            internetFacing: false, // internal NLB
            vpcSubnets: { subnets: [this.subnets[0]] },
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
            ec2.Port.tcp(443),
            'Allow HTTPS from within the VPC'
        );
  
        this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR,
            privateDnsEnabled: true,
            subnets: { subnets: this.subnets },
            securityGroups: [endpointSecurityGroup],
        });


        // ----------------------- App server EC2 ----------------------- //
        // Allow access Security Group 
        const sg = new ec2.SecurityGroup(this, 'ConfigServerSG', {
          vpc: this.vpc,
          description: 'Allow access to the config server',
          allowAllOutbound: true,
        });
        
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH');
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing(), 'Allow ICMP Ping');


        const role = new iam.Role(this, 'EC2InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMReadOnlyAccess'));

        const selectedAz = cdk.Stack.of(this).availabilityZones[0];
        const selectedSubnet = ec2.Subnet.fromSubnetAttributes(this, 'SelectedSubnet', {
          subnetId: props.subnetIds[0],
          availabilityZone: selectedAz,
        });
        const instance = new ec2.Instance(this, 'ConfigServerInstance', {
            vpc: this.vpc,
            instanceType: new ec2.InstanceType('t3.micro'),
            machineImage: new ec2.AmazonLinuxImage({
              generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
            }),            
            securityGroup: sg,
            vpcSubnets: { subnets: [selectedSubnet] },
            keyName: 'xils-developper',
            role,
        });

        instance.addUserData(configServerUserData);

        new cdk.CfnOutput(this, 'ConfigServerDNS', {
            value: instance.instancePublicDnsName,
        });


        // ----------------------- SSM params ----------------------- //
        [
          ['/linked/infra/vpc/id',this.vpc.vpcId],
          ['/linked/infra/nlb/dns',this.nlbDnsName],
          ['/linked/infra/nlb/arn',this.linkednlb.loadBalancerArn],
          ['/linked/infra/endpoint-service/id',this.endpointServiceId],
          ['/linked/infra/endpoint-service/name',`com.amazonaws.vpce.${this.region}.${endpointService.ref}`],
          ['/linked/infra/endpoint-service/nlb-dns',this.nlbDnsName],
        ].forEach(([param, val])=>
          new ssm.StringParameter(this,param,{ parameterName:param, stringValue:val })
        );
        
        // ----------------------- Outputs ----------------------- //
        new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName, exportName: 'LinkedNlbDnsName' });
        new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId });
        new cdk.CfnOutput(this, 'LoadBalancerArnOutput', { value: this.linkednlb.loadBalancerArn, exportName: 'LinkedNlbArn'});
    }
}
