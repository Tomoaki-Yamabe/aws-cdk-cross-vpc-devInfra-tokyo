import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { configServerUserData } from './apiserver-userdata';

interface LinkedVpcStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
}

export class LinkedInfraStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly subnets: ec2.ISubnet[];

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
        // output Endpoint DNS name
        new cdk.CfnOutput(this, 'InterfaceEndpointDns', {
          value: cdk.Fn.select(0, interfaceEndpoint.vpcEndpointDnsEntries),
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
            machineImage: new ec2.AmazonLinuxImage(),
            securityGroup: sg,
            vpcSubnets: { subnets: [selectedSubnet] },
            keyName: 'xils-developper',
            role,
        });

        instance.addUserData(configServerUserData);

        new cdk.CfnOutput(this, 'ConfigServerDNS', {
            value: instance.instancePublicDnsName,
        });
    }
}
