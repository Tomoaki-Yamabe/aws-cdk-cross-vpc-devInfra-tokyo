# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template


-----------------------------
cdk init app --language=typescript
npm install aws-cdk-lib constructs
npm install @aws-cdk/aws-ec2

-------------------------------
bin/config-server-stack.ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConfigServerStack } from '../lib/config-server-stack';

const app = new cdk.App();
new ConfigServerStack(app, 'ConfigServerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' }
});


----------------
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class EcsFargateNlbStack extends cdk.Stack {
  public readonly nlbDnsName: string;
  public readonly endpointServiceId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 既存 Isolated VPC を取得
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: 'vpc-0585987c868bcae3b',
    });

    // 利用するサブネット：各AZごとに空きが十分なものを指定
    const lbEndpointSubnetIds = ['subnet-0da5abcedf5dc1752', 'subnet-019f9b5946e43cf4e', 'subnet-0ce0bc16b4054a9d7'];
    const lbEndpointSubnets = lbEndpointSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `LBEndpointSubnet${index}`, subnetId)
    );

    // 必要な VPC エンドポイントを追加（ECR、CloudWatch Logs など）
    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: { subnets: lbEndpointSubnets },
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

    // ECSクラスターの作成
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // Fargateタスク定義の作成（コンテナはポート8501で待ち受ける設定とする）
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    // タスク実行ロールに必要な権限を追加
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
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

    // コンテナイメージ：ECR リポジトリから取得
    const ecrImage = ecs.ContainerImage.fromRegistry('481393820746.dkr.ecr.us-west-2.amazonaws.com/bedrock/sils-chatbot');

    // タスク定義にコンテナ追加（ポート8501で待ち受け）
    taskDef.addContainer('AppContainer', {
      image: ecrImage,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'ecs' }),
      portMappings: [{ containerPort: 8501 }],
    });

    // Fargate サービス作成
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnets: lbEndpointSubnets },
    });

    // Network Load Balancer (NLB) の作成（内部向け）
    const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: lbEndpointSubnets },
    });

    // NLB のリスナー作成：クライアントからは80でアクセス
    const listener = nlb.addListener('Listener', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
    });

    // NLB のターゲットグループ設定：実際のFargateコンテナは8501で稼働しているため
    listener.addTargets('ECS', {
      port: 8501, // ターゲットに向けるポートは8501
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

    // PrivateLink エンドポイントサービスとして NLB を公開（自動承認）
    const vpcEndpointService = new ec2.CfnVPCEndpointService(this, 'EndpointService', {
      networkLoadBalancerArns: [nlb.loadBalancerArn],
      acceptanceRequired: false,
    });

    this.nlbDnsName = nlb.loadBalancerDnsName;
    this.endpointServiceId = vpcEndpointService.ref;

    new cdk.CfnOutput(this, 'NlbDnsName', { value: this.nlbDnsName });
    new cdk.CfnOutput(this, 'EndpointServiceId', { value: this.endpointServiceId });

    // サービス構成情報を SSM Parameter Store に登録
    const serviceConfig = {
      serviceName: 'sils-chatbot',
      nlbDnsName: this.nlbDnsName,
      targetPort: 8501,
    };
    new ssm.StringParameter(this, 'ServiceConfigParameter', {
      parameterName: '/services/sils-chatbot/config',
      stringValue: JSON.stringify(serviceConfig),
    });
  }
}
--------------------

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class ConfigServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Linked VPC を取得（Linked VPCのIDに変更してください）
    const linkedVpc = ec2.Vpc.fromLookup(this, 'LinkedVpc', {
      vpcId: 'vpc-xxxxxxxx',  // Linked VPCのIDを指定
    });

    // 設定管理サーバー用のセキュリティグループ作成（HTTPアクセス許可）
    const sg = new ec2.SecurityGroup(this, 'ConfigServerSG', {
      vpc: linkedVpc,
      description: 'Allow HTTP access to the config server',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');

    // EC2 インスタンスを作成（設定管理サーバー）
    const instance = new ec2.Instance(this, 'ConfigServerInstance', {
      vpc: linkedVpc,
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: sg,
    });

    // UserData: シンプルな Flask アプリをセットアップして起動
    instance.addUserData(`
      #!/bin/bash
      yum update -y
      yum install -y python3
      pip3 install flask boto3
      cat <<'EOF' > /home/ec2-user/config_server.py
      from flask import Flask, jsonify
      import boto3
      import json
      app = Flask(__name__)
      ssm = boto3.client('ssm', region_name='us-west-2')
      
      @app.route('/')
      def index():
          try:
              response = ssm.get_parameter(Name='/services/sils-chatbot/config')
              config = json.loads(response['Parameter']['Value'])
          except Exception as e:
              config = {'error': str(e)}
          return jsonify(config)
      
      if __name__ == '__main__':
          app.run(host='0.0.0.0', port=80)
      EOF
      nohup python3 /home/ec2-user/config_server.py > /var/log/config_server.log 2>&1 &
    `);

    new cdk.CfnOutput(this, 'ConfigServerPublicDns', {
      value: instance.instancePublicDnsName,
    });
  }
}
