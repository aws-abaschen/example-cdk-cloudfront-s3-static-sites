#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { CloudfrontS3StaticSitesStack } from '../lib/cloudfront-s3-static-sites-stack';

const app = new cdk.App();
// const common = new CommonStack(app, 'CommonResources', {
//   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
// })
new CloudfrontS3StaticSitesStack(app, 'MySites', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  project: 'mysite',

  
});
