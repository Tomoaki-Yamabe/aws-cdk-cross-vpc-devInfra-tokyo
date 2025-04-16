import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';

export interface EcsServiceStackProps extends cdk.StackProps {
  loadBalancerArn: string;
  cluster: ecs.Cluster;
  vpc: ec2.IVpc;
  sharedNlb: elbv2.NetworkLoadBalancer;
  listenerPort: number;
  containerPort: number;
  ecrRepoName: string;
  serviceName: string;
  memoryLimitMiB: number;
  cpu: number;
}

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'SILS');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
        memoryLimitMiB: props.memoryLimitMiB,
        cpu: props.cpu,
      });

    // create execution role for ECS task
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
        actions: [
            'ecr:*',
            'logs:*',
        ],
        resources: ['*'],
    }));
    

    // inport ECR repository and defenition container
    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'EcrRepo', props.ecrRepoName);
    taskDef.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: props.serviceName }),
      portMappings: [{ containerPort: props.containerPort }],
    });


    // create Fargate survice
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
    });


    // create listener
    // const importedNlb = elbv2.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'ImportedNlb', {
    //   loadBalancerArn: props.loadBalancerArn,
    //   vpc: props.vpc,
    // });
    // const listener = new elbv2.NetworkListener(this, 'ServiceListener', {
    //   loadBalancer: importedNlb,
    //   port: props.listenerPort,
    //   protocol: elbv2.Protocol.TCP,
    // });

    const listener = props.sharedNlb.addListener(`${props.serviceName}Listener`, {
      port: props.listenerPort,
      protocol: elbv2.Protocol.TCP,
    });

    // 
    // const listener = props.sharedNlb.addListener(`${props.serviceName}Listener`, {
    //   port: props.listenerPort,
    //   protocol: elbv2.Protocol.TCP,
    // });

   
    // create target group and attach to NLB listener
    listener.addTargets(`${props.serviceName}Target`, {
      port: props.containerPort,
      targets: [service.loadBalancerTarget({
        containerName: 'AppContainer',
        containerPort: props.containerPort,
      })],
      healthCheck: {
        port: `${props.containerPort}`,
        protocol: elbv2.Protocol.TCP,
      },
    });

    // ------------ CodePipeline ------------ //
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
    pipelineName: `${props.serviceName}-Pipeline`,
    });   

    const sourceOutput = new codepipeline.Artifact();

    pipeline.addStage({
    stageName: 'Source',
    actions: [
        new actions.EcrSourceAction({
        actionName: 'ECRSource',
        repository: ecrRepo,
        imageTag: 'latest',
        output: sourceOutput,
        }),
    ],
    });

    pipeline.addStage({
    stageName: 'Deploy',
    actions: [
        new actions.EcsDeployAction({
        actionName: 'DeployAction',
        service,
        input: sourceOutput,
        }),
    ],
    });

    // output ssm parameter
    new ssm.StringParameter(this, `${props.serviceName}ConfigParameter`, {
      parameterName: `/services/${props.serviceName}/config`,
      stringValue: JSON.stringify({
        serviceName: props.serviceName,
        nlbDnsName: props.sharedNlb.loadBalancerDnsName,
        listenerPort: props.listenerPort,
        targetPort: props.containerPort,
      }),
    });


    new cdk.CfnOutput(this, `${props.serviceName}NlbDnsName`, { 
      value: props.sharedNlb.loadBalancerDnsName 
    });
  }
}
