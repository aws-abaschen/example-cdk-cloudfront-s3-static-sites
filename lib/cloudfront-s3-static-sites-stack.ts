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
  webAclArn: string
  originAccessControlId: string

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
    
    const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: 'StrictResponseHeadersPolicy',
      comment: 'A policy for strict response headers',
      /*corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['X-Custom-Header-1', 'X-Custom-Header-2'],
        accessControlAllowMethods: ['GET', 'POST'],
        accessControlAllowOrigins: ['*'],
        //accessControlExposeHeaders: ['X-Custom-Header-1', 'X-Custom-Header-2'],
        accessControlMaxAge: cdk.Duration.seconds(600),
        originOverride: true,
      },*/
      /*customHeadersBehavior: {
        customHeaders: [
          { header: 'X-Amz-Date', value: 'some-value', override: true },
          { header: 'X-Amz-Security-Token', value: 'some-value', override: false },
        ],
      },*/
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: "default-src https:; default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data; style-src 'self'; frame-ancestors 'self'; form-action 'self';", override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.seconds(600), includeSubdomains: true, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      removeHeaders: ['Server'],
      serverTimingSamplingRate: 50,
    });

    new Site(this, {
      siteName: `VueJS-${this.deploymentEnv}`,
      origins:  
        {
          '/assets/videos/*': 'videos'
        }
      ,
      accessLogsBucketArn: props.accessLogsBucketArn,
      webAclArn: props.webAclArn,
      originAccessControlId: props.originAccessControlId

    });

    
  }
}
