import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
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
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly nlbDnsName: string;
    public readonly albDnsName: string;
    public readonly endpointServiceId: string;
    public readonly loadBalancerArn: string;
    public readonly albArn: string;

    constructor(scope: Construct, id: string, props: IsolatedVpcStackProps) {
        super(scope, id, props);

        cdk.Tags.of(this).add('Project', 'EliteGen2');
        cdk.Tags.of(this).add('Environment', 'Production');
        cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
        cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

        
        this.vpc = ec2.Vpc.fromLookup(this,'IsolatedVpc',{ vpcId:props.vpcId });
        const azs = cdk.Stack.of(this).availabilityZones;
        this.subnets = props.subnetIds.map((id,i)=>
          ec2.Subnet.fromSubnetAttributes(this,`IsoSubnet${i}`,{
            subnetId:id,
            availabilityZone:azs[i % azs.length],
          })
        );


        // ----------------------- Private Link Attachment ----------------------- //
        // Connection Isolated to Linked VPC endpoint
        // const LinkedEndpointServiceName = ssm.StringParameter.valueForStringParameter(
        //     this, '/linked/infra/endpoint-service/name'
        // );



        // const linkSg = new ec2.SecurityGroup(this,'IsoToLinkSG',{ vpc:this.vpc, allowAllOutbound:true });
        // linkSg.addIngressRule(ec2.Peer.anyIpv4(),ec2.Port.allTcp(),'Allow all TCP ports');
        // const toLinkedEndpoint = this.vpc.addInterfaceEndpoint('ToLinkedEndpoint',{
        //     service:new ec2.InterfaceVpcEndpointService(LinkedEndpointServiceName,80),
        //     privateDnsEnabled:false,
        //     subnets:{ subnets: this.subnets },
        //     securityGroups:[linkSg],
        // });
        // new cdk.CfnOutput(this, 'ToLinkedDns', {
        //     value: cdk.Fn.select(0, toLinkedEndpoint.vpcEndpointDnsEntries),
        // });


        // ----------------------- NLB ----------------------- //
        // create and shared internal NLB
        this.nlb = new elbv2.NetworkLoadBalancer(this, 'SharedNLB', {
            vpc: this.vpc,
            internetFacing: false, // internal NLB
            vpcSubnets: { subnets: this.subnets },
            crossZoneEnabled: true,
        });
        this.nlbDnsName = this.nlb.loadBalancerDnsName;
        this.loadBalancerArn = this.nlb.loadBalancerArn;


        // ----------------------- Endpoint Service ----------------------- //
        // create Private endpoint service
        const endpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
            networkLoadBalancerArns: [this.nlb.loadBalancerArn],
            acceptanceRequired: false, // auto authentification
        });
        this.endpointServiceId = endpointService.ref;


        // ----------------------- ECS ----------------------- //
        this.cluster = new ecs.Cluster(this, 'EcsCluster', { vpc: this.vpc });

        // ----------------------- ALB ----------------------- //
        // Create ALB security group
        const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for ALB',
            allowAllOutbound: true,
        });
        
        // Allow traffic from NLB to ALB (all ports since NLB will forward different service ports)
        albSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.allTcp(),
            'Allow traffic from NLB'
        );

        // Create internal ALB
        this.alb = new elbv2.ApplicationLoadBalancer(this, 'SharedALB', {
            vpc: this.vpc,
            internetFacing: false, // internal ALB
            vpcSubnets: { subnets: this.subnets },
            securityGroup: albSg,
        });
        this.albDnsName = this.alb.loadBalancerDnsName;
        this.albArn = this.alb.loadBalancerArn;

        // Create default ALB listener with path-based routing
        const albListener = this.alb.addListener('DefaultListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.fixedResponse(200, {
                contentType: 'application/json',
                messageBody: JSON.stringify({
                    status: 'ALB is healthy',
                    message: 'Please use specific service paths for routing. Example paths: /s3control/docs*...',
                    timestamp: new Date().toISOString()
                }),
            }),
        });

        // Create test ALB listener for Blue/Green deployment validation
        const albTestListener = this.alb.addListener('TestListener', {
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.fixedResponse(200, {
                contentType: 'application/json',
                messageBody: JSON.stringify({
                    status: 'Test ALB listener is healthy',
                    message: 'This is the test listener for Blue/Green deployments',
                    timestamp: new Date().toISOString()
                }),
            }),
        });

        // Export ALB listeners for service stacks to add rules
        new ssm.StringParameter(this, 'AlbListenerArn', {
            parameterName: '/isolated/infra/alb/listener/arn',
            stringValue: albListener.listenerArn,
        });

        new ssm.StringParameter(this, 'AlbTestListenerArn', {
            parameterName: '/isolated/infra/alb/test-listener/arn',
            stringValue: albTestListener.listenerArn,
        });

        // Create NLB target group with ALB as target
        const nlbToAlbTargetGroup = new elbv2.NetworkTargetGroup(this, 'NlbToAlbTargetGroup', {
            vpc: this.vpc,
            port: 80, // Default port for ALB communication
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.ALB,
            healthCheck: {
                port: '80',
                protocol: elbv2.Protocol.HTTP,
                path: '/',
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
                timeout: cdk.Duration.seconds(6),
                interval: cdk.Duration.seconds(30),
            },
        });

        // Add ALB as target to NLB target group
        nlbToAlbTargetGroup.addTarget(new targets.AlbArnTarget(this.alb.loadBalancerArn, 80));

        // Create default NLB listener that forwards to ALB
        new elbv2.NetworkListener(this, 'NlbDefaultListener', {
            loadBalancer: this.nlb,
            port: 80,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [nlbToAlbTargetGroup],
        });


        // Create NLB TestTraffic target group with ALB as target
        const nlbToAlbTargetGroupTestListner = new elbv2.NetworkTargetGroup(this, 'NlbToAlbTargetGroupTestListner', {
            vpc: this.vpc,
            port: 8080, // Default port for ALB communication
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.ALB,
            healthCheck: {
                port: '8080',
                protocol: elbv2.Protocol.HTTP,
                path: '/',
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
                timeout: cdk.Duration.seconds(6),
                interval: cdk.Duration.seconds(30),
            },
        });

        // Add ALB as target to NLB target group
        nlbToAlbTargetGroupTestListner.addTarget(new targets.AlbArnTarget(this.alb.loadBalancerArn, 8080));

        // Create default NLB listener that forwards to ALB
        new elbv2.NetworkListener(this, 'NlbTestListener', {
            loadBalancer: this.nlb,
            port: 8080,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [nlbToAlbTargetGroupTestListner],
        });    
        


        // Create Security Group for VPC endpoints    
        const ecrSg = new ec2.SecurityGroup(this,'IsoEcrSG',{
            vpc:this.vpc, 
            allowAllOutbound:true 
        });
        // Allow access Security Group
        ecrSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(443),'ECR'
        );


        // Create VPC endpoints for ECR and CloudWatch Logs
        const services: [string, ec2.InterfaceVpcEndpointAwsService][] = [
            ['EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR],
            ['EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
            ['CloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
        ];
        services.forEach(([id, svc]) => {
            this.vpc.addInterfaceEndpoint(id, {
                service: svc,
                privateDnsEnabled: true,
                subnets: { subnets: this.subnets },
                securityGroups: [ecrSg],
            });
        });



        // ----------------------- SSM params ----------------------- //
        [
            ['/isolated/infra/vpc/id',this.vpc.vpcId],
            ['/isolated/infra/nlb/dns',this.nlbDnsName],
            ['/isolated/infra/nlb/arn',this.loadBalancerArn],
            ['/isolated/infra/alb/dns',this.albDnsName],
            ['/isolated/infra/alb/arn',this.albArn],
            ['/isolated/infra/alb/security-group-id',albSg.securityGroupId],
            ['/isolated/infra/ecs/cluster/arn',this.cluster.clusterArn],
            ['/isolated/infra/endpoint-service/id',this.endpointServiceId],
            ['/isolated/infra/endpoint-service/name',`com.amazonaws.vpce.${this.region}.${this.endpointServiceId}`],
            ['/isolated/infra/endpoint-service/nlb-dns',this.nlbDnsName],
        ].forEach(([param, val])=>
            new ssm.StringParameter(this,param,{ parameterName:param, stringValue:val })
        );

        // ----------------------- SSM params ----------------------- //
        // new ssm.StringParameter(this, 'InfraVpcId', {
        //     parameterName: '/isolated/infra/vpc/id',
        //     stringValue: this.vpc.vpcId,
        // });

        // new ssm.StringParameter(this, 'InfraNlbDnsName', {
        //     parameterName: '/isolated/infra/nlb/dns',
        //     stringValue: this.nlbDnsName,
        // });

        // new ssm.StringParameter(this, 'InfraNlbArn', {
        //     parameterName: '/isolated/infra/nlb/arn',
        //     stringValue: this.nlb.loadBalancerArn,
        // });
  
        // new ssm.StringParameter(this, 'InfraEndpointServiceId', {
        //     parameterName: '/isolated/infra/endpoint-service/id',
        //     stringValue: this.endpointServiceId,
        // });

        // // set a endpointService name to ssm parameter store
        // new ssm.StringParameter(this, 'InfraEndpointServiceName', {
        //     parameterName: '/isolated/infra/endpoint-service/name',
        //     stringValue: `com.amazonaws.vpce.${this.region}.${this.endpointServiceId}`,
        // });
        // // set a endpoint service nld dns name to ssm parameter store
        // new ssm.StringParameter(this, 'InfraEndpointServiceNlbDns', {
        //     parameterName: '/isolated/infra/endpoint-service/nlb-dns',
        //     stringValue: this.nlbDnsName,
        // });

        // ----------------------- Outputs ----------------------- //
        new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName, exportName: 'IsolatedNlbDnsName' });
        new cdk.CfnOutput(this, 'AlbDnsName', { value: this.albDnsName, exportName: 'IsolatedAlbDnsName' });
        new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId, exportName: 'IsoEndpointServiceId' });
        new cdk.CfnOutput(this, 'LoadBalancerArnOutput', { value: this.nlb.loadBalancerArn, exportName: 'IsolatedNlbArn' });
        new cdk.CfnOutput(this, 'AlbArnOutput', { value: this.alb.loadBalancerArn, exportName: 'IsolatedAlbArn' });
    }
}