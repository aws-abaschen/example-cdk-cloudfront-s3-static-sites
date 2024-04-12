import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Site } from './Site';
import { CommonStack } from './CommonResources';
import { CachePolicy, CfnOriginAccessControl, HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

export interface CloudfrontS3StaticSitesStackProps extends cdk.StackProps {
  deploymentEnv?: string;
  project: string
  accessLogsBucketArn: string

}

export class CloudfrontS3StaticSitesStack extends cdk.Stack {
  readonly deploymentEnv?: string;
  readonly common: CommonStack
  readonly project: string

  constructor(scope: Construct, id: string, props: CloudfrontS3StaticSitesStackProps) {
    super(scope, id, props);
    this.project = props.project;
    this.deploymentEnv = props?.deploymentEnv ?? 'dev';

    new Site(this, {
      siteName: `VueJS-${this.deploymentEnv}`,
      origins:  
        {
          '/sub-site/': 'subsite'
        }
      ,
      accessLogsBucketArn: props.accessLogsBucketArn,

    });

    
  }
}
