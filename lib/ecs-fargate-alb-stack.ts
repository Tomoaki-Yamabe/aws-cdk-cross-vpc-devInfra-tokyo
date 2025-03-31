import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';


export class EcsFargateAlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Select vpb
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: 'vpc-0585987c868bcae3b',
    });

    // get all PRIVATE_WITH_EGRESS subnet
    const allPrivateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;
    
    // Eliminate duplicate selections
    const uniqueAzSubnets = Array.from(
      new Map(allPrivateSubnets.map(s => [s.availabilityZone, s])).values()
    );

    // create ECS clustor
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // define Fargate task.json
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });
    
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
    });

    // create ALB and adde listner
    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      internetFacing: false,
      vpcSubnets: {
        subnets: uniqueAzSubnets,
      },
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
