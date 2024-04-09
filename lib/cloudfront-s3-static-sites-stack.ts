import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Site } from './Site';
import { CommonStack } from './CommonResources';
import { CachePolicy } from 'aws-cdk-lib/aws-cloudfront';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

export interface CloudfrontS3StaticSitesStackProps extends cdk.StackProps {
  deploymentEnv?: string;
  common: CommonStack
  project: string
}

export class CloudfrontS3StaticSitesStack extends cdk.Stack {
  readonly deploymentEnv?: string;
  readonly common: CommonStack
  readonly project: string

  constructor(scope: Construct, id: string, props: CloudfrontS3StaticSitesStackProps) {
    super(scope, id, props);
    this.project = props.project;
    this.deploymentEnv = props?.deploymentEnv ?? 'dev';

    const cachePolicy_HostAcceptOrigin = new CachePolicy(this, 'HostAcceptOrigin-ForwardedCache', {
      cachePolicyName: 'HostAcceptOrigin-ForwardedCache',
      defaultTtl: cdk.Duration.hours(1),
      minTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      queryStringBehavior: {
        behavior: 'all'
      },
      headerBehavior: {
        headers: ["Host", "Accept", "Origin"],
        behavior: 'whitelist'
      }
    });

    new Site(this, {
      siteName: `VueJS-${this.deploymentEnv}`,
      cacheBehaviors: [
        {
          '/assets/*': {
            allowedMethods: cdk.aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cdk.aws_cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
            compress: true,
            cachePolicy: cachePolicy_HostAcceptOrigin,
            viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          }
        }
      ],
      webAcl: props.common.webAcl,
      originAccessIdentity: props.common.originAccessIdentity

    });

    
  }
}
