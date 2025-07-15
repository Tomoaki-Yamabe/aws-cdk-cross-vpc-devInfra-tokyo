import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';

export interface EcsServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  containerPort: number;
  ecrRepoName: string;
  serviceName: string;
  memoryLimitMiB: number;
  cpu: number;
  servicePath: string; // パスベースルーティング用のパス（例: /chatbot/*）
}

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

    // Get values from SSM Parameter Store
    const clusterArn = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/ecs/cluster/arn');
    const albArn = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/alb/arn');
    const albDnsName = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/alb/dns');
    const albSecurityGroupId = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/alb/security-group-id');
    const albListenerArn = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/alb/listener/arn');
    const albTestListenerArn = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/alb/test-listener/arn');
    const nlbDnsName = ssm.StringParameter.valueForStringParameter(this, '/isolated/infra/nlb/dns');

    // Extract cluster name from ARN
    const clusterName = cdk.Stack.of(this).splitArn(clusterArn, cdk.ArnFormat.SLASH_RESOURCE_NAME).resourceName!;

    // Import resources from SSM parameters
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterArn: clusterArn,
      clusterName: clusterName,
      vpc: props.vpc,
    });
    const alb = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, 'ImportedALB', {
      loadBalancerArn: albArn,
      vpc: props.vpc,
      loadBalancerDnsName: albDnsName,
      securityGroupId: albSecurityGroupId,
    });

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

    // import ECR repository and definition container
    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'EcrRepo', props.ecrRepoName);
    
    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/ecs/${props.serviceName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    
    taskDef.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup,
        streamPrefix: props.serviceName
      }),
      portMappings: [{ containerPort: props.containerPort }],
      environment: {
        SUB_PATH: props.servicePath.replace('/*', ''),
      },
    });

    const fargateSg = new ec2.SecurityGroup(this, 'FargateServiceSG', {
      vpc: props.vpc,
      description: 'Allow all TCP traffic',
      allowAllOutbound: true,
    });

    fargateSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(0, 65535), 'Allow all TCP from anywhere');

    // create Fargate service
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster: cluster,
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
        unhealthyThresholdCount: 5,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(15),
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
        unhealthyThresholdCount: 5,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(15),
      },
    });

    // Import existing ALB listener and add path-based routing rule
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'ImportedListener', {
      listenerArn: albListenerArn,
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'ImportedAlbSG', albSecurityGroupId),
    });

    // Import shared test listener from infra stack
    const testListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'TestListener', {
      listenerArn: albTestListenerArn,
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'TestListenerSG', albSecurityGroupId),
    });

    // Add path-based routing rule to the existing listener
    // Support both exact path match and wildcard pattern
    const basePath = props.servicePath.replace('/*', '');
    
    new elbv2.ApplicationListenerRule(this, `${props.serviceName}ListenerRule`, {
      listener: listener,
      priority: this.generatePriority(props.servicePath),
      conditions: [
        elbv2.ListenerCondition.pathPatterns([basePath, props.servicePath])
      ],
      targetGroups: [blueTargetGroup],
    });

    // Add path-based routing rule to the test listener
    // Note: Initially points to the same target group as production listener
    // Test listener routes to Green target group for Blue/Green deployment validation
    new elbv2.ApplicationListenerRule(this, `${props.serviceName}TestListenerRule`, {
      listener: testListener,
      priority: this.generatePriority(props.servicePath), // 本番リスナーと同じ動的優先度生成
      conditions: [
        elbv2.ListenerCondition.pathPatterns([basePath, props.servicePath])
      ],
      targetGroups: [greenTargetGroup], // テストリスナーはGreenターゲットグループを指す
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
        terminationWaitTime: cdk.Duration.minutes(5), // 5分後に古いタスクセット終了
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
    });

    // ------------ CodePipeline ------------ //
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${props.serviceName}-Pipeline`,
    });

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    // CodeBuild project to generate deployment artifacts for Blue/Green
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
  "executionRoleArn": "${taskDef.executionRole?.roleArn}",
  "containerDefinitions": [
    {
      "name": "AppContainer",
      "image": "<IMAGE1_NAME>",
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
      },
      "environment": [
        {
          "name": "SUB_PATH",
          "value": "${props.servicePath.replace('/*', '')}"
        }
      ]
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

    // Add manual approval stage before deployment
    pipeline.addStage({
      stageName: 'Approval',
      actions: [
        new actions.ManualApprovalAction({
          actionName: 'ManualApproval',
          additionalInformation: `Please review the changes and approve deployment for ${props.serviceName}. After deployment starts, you can test the Green environment using the test listener on port 8080.`,
          externalEntityLink: `http://${albDnsName}:8080${basePath}`, // テスト用リンク
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
          containerImageInputs: [
            {
              input: sourceOutput,
              taskDefinitionPlaceholder: 'IMAGE1_NAME',
            },
          ],
        }),
      ],
    });

    // output ssm parameter
    new ssm.StringParameter(this, `${props.serviceName}ConfigParameter`, {
      parameterName: `/services/${props.serviceName}/config`,
      stringValue: JSON.stringify({
        serviceName: props.serviceName,
        nlbDnsName: nlbDnsName,
        servicePath: props.servicePath,
        targetPort: props.containerPort,
      }),
    });

    new cdk.CfnOutput(this, `${props.serviceName}ServicePath`, {
      value: props.servicePath,
      description: `Service path for ${props.serviceName}`,
    });

    new cdk.CfnOutput(this, `${props.serviceName}AlbDnsName`, {
      value: albDnsName,
    });

    new cdk.CfnOutput(this, `${props.serviceName}TestListenerUrl`, {
      value: `http://${albDnsName}:8080${basePath}`,
      description: `Test URL for Green environment validation during Blue/Green deployment - ${props.serviceName}. CodeDeploy automatically routes this to Green taskset during deployment.`,
    });

    new cdk.CfnOutput(this, `${props.serviceName}ProductionUrl`, {
      value: `http://${albDnsName}${basePath}`,
      description: `Production URL for ${props.serviceName} - Always points to active (Blue) environment`,
    });

    new cdk.CfnOutput(this, `${props.serviceName}DeploymentInstructions`, {
      value: `Blue/Green Deployment Flow: 1) Deploy starts 2) Test Green environment at :8080 3) Wait ${cdk.Duration.minutes(10).toMinutes()} minutes 4) Auto-switch to production 5) Blue environment terminated`,
      description: `Deployment instructions for ${props.serviceName}`,
    });
  }

  // Generate priority based on service path for ALB listener rules
  private generatePriority(servicePath: string): number {
    // Simple hash-based priority generation to avoid conflicts
    let hash = 0;
    for (let i = 0; i < servicePath.length; i++) {
      const char = servicePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Ensure priority is between 1 and 50000 (ALB limit)
    return Math.abs(hash % 49999) + 1;
  }

}
