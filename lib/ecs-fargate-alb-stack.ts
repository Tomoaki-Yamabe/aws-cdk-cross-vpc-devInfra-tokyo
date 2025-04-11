import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';


export class EcsFargateAlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Select vpc
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: 'vpc-0585987c868bcae3b',
    });

    const lbEndpointSubnetIds = ['subnet-0da5abcedf5dc1752', 'subnet-019f9b5946e43cf4e', 'subnet-0ce0bc16b4054a9d7'];
    const lbEndpointSubnets = lbEndpointSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `LBEndpointSubnet${index}`, subnetId)
    );

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

    // import container
    const ecrImage = ecs.ContainerImage.fromRegistry('481393820746.dkr.ecr.us-west-2.amazonaws.com/bedrock/sils-chatbot');

    taskDef.addContainer('AppContainer', {
      image: ecrImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'ecs' }),
      portMappings: [{ containerPort: 80 }],
    });

    // create Fargate survice
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnets: lbEndpointSubnets },
    });

    // create ALB and adde listner
    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: lbEndpointSubnets },
    });

    const listener = lb.addListener('Listener', {
      port: 80,
      open: true,
    });

    // Linking target.json
    listener.addTargets('ECS', {
      port: 80,
      targets: [service],
      healthCheck: {
        path: '/',
      },
    });

    // set alb dns name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: lb.loadBalancerDnsName,
    });
  }
}
