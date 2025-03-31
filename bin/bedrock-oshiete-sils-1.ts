#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsFargateAlbStack } from '../lib/ecs-fargate-alb-stack';

const app = new cdk.App();

new EcsFargateAlbStack(app, 'BedrockOshieteSils1Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
});

