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
  loadBalancerDnsName: string;
  cluster: ecs.Cluster;
  vpc: ec2.IVpc;
  listenerPort: number;
  containerPort: number;
  ecrRepoName: string;
  serviceName: string;
  memoryLimitMiB: number;
  cpu: number;
  // IAMロール設定用の新しいプロパティ
  taskRolePolicies?: Array<{
    actions: string[];
    resources: string[];
    conditions?: any;
  }>;
  managedPolicies?: string[];
}

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

    // Task Role（アプリケーションが使用するAWSサービスへのアクセス権限）
    let taskRole: iam.Role | undefined;
    
    if (props.taskRolePolicies || props.managedPolicies) {
      taskRole = new iam.Role(this, 'TaskRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description: `Task role for ${props.serviceName} ECS service`,
      });

      // カスタムポリシーの追加
      if (props.taskRolePolicies) {
        props.taskRolePolicies.forEach((policy, index) => {
          taskRole!.addToPolicy(new iam.PolicyStatement({
            actions: policy.actions,
            resources: policy.resources,
            conditions: policy.conditions,
          }));
        });
      }

      // 管理ポリシーの追加
      if (props.managedPolicies) {
        props.managedPolicies.forEach((policyArn, index) => {
          if (policyArn.startsWith('arn:aws:iam::aws:policy/')) {
            // AWS管理ポリシーの場合
            taskRole!.addManagedPolicy(
              iam.ManagedPolicy.fromAwsManagedPolicyName(policyArn.split('/').pop()!)
            );
          } else {
            // カスタム管理ポリシーの場合
            taskRole!.addManagedPolicy(
              iam.ManagedPolicy.fromManagedPolicyArn(this, `ManagedPolicy${index}`, policyArn)
            );
          }
        });
      }
    }

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      taskRole: taskRole, // Task Roleを設定
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

    const fargateSg = new ec2.SecurityGroup(this, 'FargateServiceSG', {
      vpc: props.vpc,
      description: 'Allow all TCP traffic',
      allowAllOutbound: true,
    });

    fargateSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(0, 65535), 'Allow all TCP from anywhere');
    

    // create Fargate survice
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster: props.cluster,
        taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      securityGroups: [fargateSg],
    });

    // Import the existing NLB by ARN
    const importedNlb = elbv2.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'ImportedNLB', {
      loadBalancerArn: props.loadBalancerArn,
      vpc: props.vpc,
      loadBalancerDnsName: cdk.Fn.importValue('IsolatedNlbDnsName'),
    });

    // Create listener and associate directly with service's target group
    const listener = new elbv2.NetworkListener(this, `${props.serviceName}Listener`, {
      loadBalancer: importedNlb,
      port: props.listenerPort,
      protocol: elbv2.Protocol.TCP,
    });

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
          actionName: 'BlueGreen-DeployECS',
          service,
          input: sourceOutput,
        }),
      ],
    });

    // LinkedVPCへのPrivateLink接続は後で設定（一時的にコメントアウト）
    // const endpointDns = ssm.StringParameter.valueForStringParameter(
    //   this,
    //   '/linked/infra/endpoint-service/endpoint-dns'
    // );

    // output ssm parameter
    new ssm.StringParameter(this, `${props.serviceName}ConfigParameter`, {
      parameterName: `/services/${props.serviceName}/config`,
      stringValue: JSON.stringify({
        serviceName: props.serviceName,
        nlbDnsName: props.loadBalancerDnsName, // 一時的にIsolated側のNLB DNS名を使用
        listenerPort: props.listenerPort,
        targetPort: props.containerPort,
      }),
    });

    new cdk.CfnOutput(this, `${props.serviceName}NlbDnsName`, {
      value: importedNlb.loadBalancerDnsName,
    });
  }
}
