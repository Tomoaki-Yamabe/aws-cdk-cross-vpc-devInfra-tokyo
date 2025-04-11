import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';


const LISTENER_PORT = 80;  // oshiete shils

export class EcsFargateAlbStack extends cdk.Stack {
  public readonly endpointServiceId: string;   // output endpoint service id
  public readonly nlbDnsName: string;   // output dns namte

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Select available vpc
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: 'vpc-0585987c868bcae3b',
    });

    const lbEndpointSubnetIds = ['subnet-0da5abcedf5dc1752', 'subnet-019f9b5946e43cf4e', 'subnet-0ce0bc16b4054a9d7'];
    const lbEndpointSubnets = lbEndpointSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `LBEndpointSubnet${index}`, subnetId)
    );


    // add necessary vpc endpoint
    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: { subnets: lbEndpointSubnets  },
    });

    vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: { subnets: lbEndpointSubnets },
    });

    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: { subnets: lbEndpointSubnets },
    });
    

    // create ECS clustor
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // define Fargate task.json
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });
    
    // attach poricy for execution role
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));


    // import container image
    const ecrImage = ecs.ContainerImage.fromRegistry('481393820746.dkr.ecr.us-west-2.amazonaws.com/bedrock/sils-chatbot');

    taskDef.addContainer('AppContainer', {
      image: ecrImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'ecs' }),
      portMappings: [{ containerPort: 8501 }],
    });

    // create Fargate survice
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnets: lbEndpointSubnets },
    });

    service.connections.securityGroups[0].addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8501),
      'Allow NLB to access Fargate service'
    );

    // create NLB and adde listner
    const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: lbEndpointSubnets},
    });
    const listener = nlb.addListener('Listener', {
      port: LISTENER_PORT,
      protocol: elbv2.Protocol.TCP,
    });

    // Linking target.json
    listener.addTargets('ECS', {
      port: 8501,
      protocol: elbv2.Protocol.TCP,
      targets: [service.loadBalancerTarget({
        containerName: 'AppContainer',
        containerPort: 8501,
      })],
      healthCheck: {
        port: '8501',
        protocol: elbv2.Protocol.TCP,
      },
    });

    // --------------------------------------

    // create Private endpoint service
    const vpcEndpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
      networkLoadBalancerArns: [nlb.loadBalancerArn],
      acceptanceRequired: false, // auto authentification
    });

    // set a endpointService name to ssm parameter store
    new ssm.StringParameter(this, 'EndpointServiceNameParameter', {
      parameterName: '/infra/endpoint-service/name',
      stringValue: `com.amazonaws.vpce.us-west-2.${vpcEndpointService.ref}`,
    });
    // set a endpoint service nld dns name to ssm parameter store
    new ssm.StringParameter(this, 'EndpointServiceNlbDnsParameter', {
      parameterName: '/infra/endpoint-service/nlb-dns',
      stringValue: nlb.loadBalancerDnsName,
    });

    // output dns name and endpoint service id
    this.nlbDnsName = nlb.loadBalancerDnsName;
    this.endpointServiceId = vpcEndpointService.ref;

    new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName });
    new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId });

    // set to ssm parameter store
    const serviceConfig = {
      serviceName: 'xils-backend-service',
      nlbDnsName: this.nlbDnsName,
      listenerPort: LISTENER_PORT,
      targetPort: 8501,
    };
    new ssm.StringParameter(this, 'ServiceConfigParameter',{
      parameterName: '/services/xils-backend-service/config',
      stringValue: JSON.stringify(serviceConfig),
    })

  }
}
