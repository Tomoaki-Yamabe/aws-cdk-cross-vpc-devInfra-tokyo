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
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';

export interface EcsServiceStackProps extends cdk.StackProps {
  loadBalancerArn: string;
  loadBalancerDnsName: string;
  alb: elbv2.ApplicationLoadBalancer;
  albDnsName: string;
  cluster: ecs.Cluster;
  vpc: ec2.IVpc;
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
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
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
      deploymentController:{
        type: ecs.DeploymentControllerType.CODE_DEPLOY
      }
    });

    // Create Blue and Green target groups for ALB Blue/Green deployment
    const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, `${props.serviceName}BlueTargetGroup`, {
      vpc: props.vpc,
      port: props.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        port: `${props.containerPort}`,
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
      },
    });

    const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, `${props.serviceName}GreenTargetGroup`, {
      vpc: props.vpc,
      port: props.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        port: `${props.containerPort}`,
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Create ALB listener and associate with blue target group initially
    const listener = new elbv2.ApplicationListener(this, `${props.serviceName}Listener`, {
      loadBalancer: props.alb,
      port: props.listenerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [blueTargetGroup],
    });

    // Register the service with the blue target group initially
    blueTargetGroup.addTarget(service.loadBalancerTarget({
      containerName: 'AppContainer',
      containerPort: props.containerPort,
    }));



    // ------------ CodeDeploy for Blue/Green ------------ //
    const codeDeployApp = new codedeploy.EcsApplication(this, 'CodeDeployApp', {
      applicationName: `${props.serviceName}-CodeDeploy`,
    });

    const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'DeploymentGroup', {
      application: codeDeployApp,
      service: service,
      blueGreenDeploymentConfig: {
        listener: listener,
        blueTargetGroup: blueTargetGroup,
        greenTargetGroup: greenTargetGroup,
        deploymentApprovalWaitTime: cdk.Duration.minutes(5),
        terminationWaitTime: cdk.Duration.minutes(5),
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });

    // ------------ CodePipeline ------------ //
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${props.serviceName}-Pipeline`,
    });

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    // CodeBuild project to generate deployment artifacts for Blue/Green
    // ほんとは外部にbuild-speck.ymlとしておきたいけど、app.tsでfor文で回しているせいで内部に記述もっと良い方法があると思われ
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${props.serviceName}-build`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: false,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // Generate imagedefinitions.json
              `echo '[{"name":"AppContainer","imageUri":"${ecrRepo.repositoryUri}:latest"}]' > imagedefinitions.json`,
              // Generate appspec.yaml for Blue/Green deployment
              `cat > appspec.yaml << 'EOF'
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: <TASK_DEFINITION>
        LoadBalancerInfo:
          ContainerName: "AppContainer"
          ContainerPort: ${props.containerPort}
EOF`,
              // Generate taskdef.json template
              `cat > taskdef.json << 'EOF'
{
  "family": "${taskDef.family}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${props.cpu}",
  "memory": "${props.memoryLimitMiB}",
  "executionRoleArn": "<TASK_EXECUTION_ROLE>",
  "containerDefinitions": [
    {
      "name": "AppContainer",
      "image": "<IMAGE1_URI>",
      "portMappings": [
        {
          "containerPort": ${props.containerPort},
          "protocol": "tcp"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/aws/ecs/${props.serviceName}",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "${props.serviceName}"
        }
      }
    }
  ]
}
EOF`,
              'cat imagedefinitions.json',
              'cat appspec.yaml',
              'cat taskdef.json'
            ]
          }
        },
        artifacts: {
          files: ['imagedefinitions.json', 'appspec.yaml', 'taskdef.json']
        }
      })
    });

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
      stageName: 'Build',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'GenerateImageDefinitions',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new actions.CodeDeployEcsDeployAction({
          actionName: 'BlueGreenDeploy',
          deploymentGroup: deploymentGroup,
          appSpecTemplateInput: buildOutput,
          taskDefinitionTemplateInput: buildOutput,
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

    new cdk.CfnOutput(this, `${props.serviceName}AlbDnsName`, {
      value: props.albDnsName,
    });
  }
}
