// bin/app.ts
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { IsolatedInfraStack } from '../lib/base-isolated/infra-stack';
import { LinkedInfraStack } from '../lib/base-linked/infra-stack';
import { EcsServiceStack } from '../lib/services-isolated/ecs-service-stack';
import { OnpremConnectorStack } from '../lib/services-isolated/onprem-connector-stack';

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

// --------------------- Isolated to onPrem PrivateLink ruting rule --------------------- //

const AwsToOnprem_Connector = [
  {
    id: 'onpremise-gitlabas4-server-port',
    onpremTargetIp: '172.23.11.223',
    onpremTargetPort: 80,
    isolateVpcReceivePort: 80,
  },
  {
    id: 'onpremise-gitlab-server-port',
    onpremTargetIp: '172.25.220.91',
    onpremTargetPort: 60139,
    isolateVpcReceivePort: 60139,
  },
  {
    id: 'onpremise-silver-server-port',
    onpremTargetIp: '172.25.220.91',
    onpremTargetPort: 27020,
    isolateVpcReceivePort: 27020,
  },
  {
    id: 'onpremise-carmaker-server-port',
    onpremTargetIp: '172.27.119.135',
    onpremTargetPort: 11010,
    isolateVpcReceivePort: 11010,
  },
  {
    id: 'onpremise-matlab-server-port',
    onpremTargetIp: ['172.27.119.130', '172.27.119.132', '172.27.119.129'],
    onpremTargetPort: 27400,
    isolateVpcReceivePort: 27400,
  }
];

// -------------------  Isolated VPC Services ------------------- //

const services = [
  {
    id: 'ChatbotService',
    ecrRepoName: 'bedrock/sils-chatbot',
    containerPort: 8501,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'chatbot-service',
    servicePath: '/chatbot/*',
  },
  {
    id: 'S3Control',
    ecrRepoName: 'xils-backend-s3control',
    containerPort: 8000,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 's3Control-service',
    servicePath: '/s3control/*',
  },
  {
    id: 'EC2Control',
    ecrRepoName: 'xils-controlec2',
    containerPort: 5000,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'ec2control-service',
    servicePath: '/ec2control/*',
  },
  {
    id: 'Dorawio',
    ecrRepoName: 'xils-backend-drawio',
    containerPort: 8080,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'drawio-service',
    servicePath: '/drawio/*',
  },
  {
    id: 'EC2Control-IAP',
    ecrRepoName: 'xils-backend-iap-controlec2',
    containerPort: 5000,
    memoryLimitMiB: 1024,
    cpu: 512,
    serviceName: 'ec2control-service-IAP',
    servicePath: '/ec2control-iap/*',
  },
];

for (const svc of services) {
  new EcsServiceStack(app, `XILS-APP-${svc.id}`, {
    env,
    vpc: infraStack.vpc,
    ...svc,
  });
}

// --------------------- Onpremise Connector --------------------- //
// Create onpremise connector stack for PrivateLink port sharing
if (AwsToOnprem_Connector && AwsToOnprem_Connector.length > 0) {
  new OnpremConnectorStack(app, 'XILS-OnpremConnector', {
    env,
    connectors: AwsToOnprem_Connector,
  });
}