// bin/app.ts
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { IsolatedInfraStack } from '../lib/base-isolated/infra-stack';
import { LinkedInfraStack } from '../lib/base-linked/infra-stack';
import { EcsServiceStack } from '../lib/services-isolated/ecs-service-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' };


// ----------------------- Linked ----------------------- //
new LinkedInfraStack(app, 'XILS-LinkedInfraStack', {
  env,
  vpcId: 'vpc-0fb356b45c911f7fd',
  subnetIds: [ 'subnet-0d2994e070b88b435' ],
  endpointServiceName: '/isolated/infra/endpoint-service/name'
});

// ----------------------- Isolated ----------------------- //
// Create the shared infrastructure stack.
const infraStack = new IsolatedInfraStack(app, 'XILS-IsolatedInfraStack', { 
  env,
  vpcId: 'vpc-0e7cbf03a96f57ed9',
  subnetIds: [
    'subnet-0946dbacc0fa49edc',
    'subnet-07800dd2b3e7a7401',
    'subnet-0fb7d240419bcb4fe'
  ],
});

// Services
const services = [
  {
    id: 'ChatbotService',
    ecrRepoName: 'bedrock/sils-chatbot',
    containerPort: 8501,
    listenerPort: 50000,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'chatbot-service',
  },
  {
    id: 'S3Control',
    ecrRepoName: 'xils-backend-s3control',
    containerPort: 8000,
    listenerPort: 50001,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'gets3data-service',
  },
  {
    id: 'EC2Control',
    ecrRepoName: 'xils-controlec2',
    containerPort: 5000,
    listenerPort: 50002,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'ec2control-service',
  },
  {
    id: 'Dorawio',
    ecrRepoName: 'xils-backend-drawio',
    containerPort: 8080,
    listenerPort: 50003,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'drawio-service',
  },
  {
    id: 'EC2Control-IAP',
    ecrRepoName: 'xils-backend-iap-controlec2',
    containerPort: 5000,
    listenerPort: 50004,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'ec2control-service-IAP',
  },

  
];

for (const svc of services) {
  new EcsServiceStack(app, `XILS-APP-${svc.id}`, {
    env,
    loadBalancerArn: infraStack.loadBalancerArn,
    loadBalancerDnsName : infraStack.nlbDnsName,
    cluster: infraStack.cluster,
    vpc: infraStack.vpc,
    ...svc,
  });
}