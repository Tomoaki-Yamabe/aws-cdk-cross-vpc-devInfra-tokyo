// bin/app.ts
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IsolatedInfraStack } from '../lib/base-isolated/infra-stack';
import { LinkedInfraStack } from '../lib/base-linked/infra-stack';
import { EcsServiceStack } from '../lib/services-isolated/ecs-service-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' };


// ----------------------- Linked ----------------------- //
new LinkedInfraStack(app, 'SILS-LinkedInfraStack', {
  env,
  vpcId: 'vpc-0390e6929bb808f12',
  subnetIds: [
    'subnet-0de4db3619f8e8e74',
    'subnet-0384a7dcbf4a7367c',
  ],
});

// ----------------------- Isolated ----------------------- //
// Create the shared infrastructure stack.
const infraStack = new IsolatedInfraStack(app, 'SILS-IsolatedInfraStack', { 
  env,
  vpcId: 'vpc-0585987c868bcae3b',
  subnetIds: [
    'subnet-0da5abcedf5dc1752',
    'subnet-019f9b5946e43cf4e',
    'subnet-0ce0bc16b4054a9d7'
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
  new EcsServiceStack(app, `SILS-APP-${svc.id}`, {
    env,
    loadBalancerArn: infraStack.loadBalancerArn,
    loadBalancerDnsName : infraStack.nlbDnsName,
    cluster: infraStack.cluster,
    vpc: infraStack.vpc,
    ...svc,
  });
}