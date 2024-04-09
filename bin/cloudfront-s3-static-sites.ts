#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudfrontS3StaticSitesStack } from '../lib/cloudfront-s3-static-sites-stack';
import { CommonStack } from '../lib/CommonResources';

const app = new cdk.App();
const common = new CommonStack(app, 'CommonResources', {})
new CloudfrontS3StaticSitesStack(app, 'CloudfrontMinisites', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    common,
    project: 'demo'
});