import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';

interface IsolatedVpcStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
}

export class IsolatedInfraStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly subnets: ec2.ISubnet[];
    public readonly cluster: ecs.Cluster;
    public readonly nlb: elbv2.NetworkLoadBalancer;
    public readonly nlbDnsName: string;
    public readonly endpointServiceId: string;
    public readonly loadBalancerArn: string;

    constructor(scope: Construct, id: string, props: IsolatedVpcStackProps) {
        super(scope, id, props);

        cdk.Tags.of(this).add('Project', 'EliteGen2');
        cdk.Tags.of(this).add('Environment', 'Production');
        cdk.Tags.of(this).add('OwnedBy', 'SILS');
        cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');
        
        this.vpc = ec2.Vpc.fromLookup(this, 'IsolatedVpc', {
            vpcId: props.vpcId,
        });
        

        const azs = cdk.Stack.of(this).availabilityZones;
        this.subnets = props.subnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetAttributes(this, `IsolatedSubnet${index}`, {
            subnetId,
            availabilityZone: azs[index % azs.length],
          })
        );

        // ----------------------- NLB ----------------------- //
        // create and shared internal NLB
        this.nlb = new elbv2.NetworkLoadBalancer(this, 'SharedNLB', {
            vpc: this.vpc,
            internetFacing: false, // internal NLB
            vpcSubnets: { subnets: this.subnets },
            crossZoneEnabled: true,
        });

        // ----------------------- Private Link Attachment ----------------------- //
        // create Private endpoint service
        const endpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
            networkLoadBalancerArns: [this.nlb.loadBalancerArn],
            acceptanceRequired: false, // auto authentification
        });
        this.endpointServiceId = endpointService.ref;
        this.nlbDnsName = this.nlb.loadBalancerDnsName;
        this.loadBalancerArn = this.nlb.loadBalancerArn;


        // ----------------------- ECS ----------------------- //
        this.cluster = new ecs.Cluster(this, 'EcsCluster', { vpc: this.vpc });
    

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
        this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            privateDnsEnabled: true,
            subnets: { subnets: this.subnets },
            securityGroups: [endpointSecurityGroup],
        });
        this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            privateDnsEnabled: true,
            subnets: { subnets: this.subnets },
            securityGroups: [endpointSecurityGroup],
        });


        // ----------------------- SSM params ----------------------- //
        new ssm.StringParameter(this, 'InfraVpcId', {
            parameterName: '/isolated/infra/vpc/id',
            stringValue: this.vpc.vpcId,
        });

        new ssm.StringParameter(this, 'InfraNlbDnsName', {
            parameterName: '/isolated/infra/nlb/dns',
            stringValue: this.nlbDnsName,
        });

        new ssm.StringParameter(this, 'InfraNlbArn', {
            parameterName: '/isolated/infra/nlb/arn',
            stringValue: this.nlb.loadBalancerArn,
        });
  
        new ssm.StringParameter(this, 'InfraEndpointServiceId', {
            parameterName: '/isolated/infra/endpoint-service/id',
            stringValue: this.endpointServiceId,
        });

        // set a endpointService name to ssm parameter store
        new ssm.StringParameter(this, 'InfraEndpointServiceName', {
            parameterName: '/isolated/infra/endpoint-service/name',
            stringValue: `com.amazonaws.vpce.${this.region}.${this.endpointServiceId}`,
        });
        // set a endpoint service nld dns name to ssm parameter store
        new ssm.StringParameter(this, 'InfraEndpointServiceNlbDns', {
            parameterName: '/isolated/infra/endpoint-service/nlb-dns',
            stringValue: this.nlbDnsName,
        });

        // ----------------------- Outputs ----------------------- //
        new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName, exportName: 'IsolatedNlbDnsName' });
        new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId });
        new cdk.CfnOutput(this, 'LoadBalancerArnOutput', { value: this.nlb.loadBalancerArn, exportName: 'IsolatedNlbArn'});
    }
}