import * as cdk from 'aws-cdk-lib';
import { AddBehaviorOptions, CachePolicy, Distribution, DistributionProps, HeadersFrameOption, HeadersReferrerPolicy, OriginAccessIdentity, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, StorageClass } from 'aws-cdk-lib/aws-s3';
import { CloudfrontS3StaticSitesStack } from './cloudfront-s3-static-sites-stack';
import { CloudFrontToS3 } from '@aws-solutions-constructs/aws-cloudfront-s3';
// import * as sqs from 'aws-cdk-lib/aws-sqs';
export interface SiteProps extends cdk.NestedStackProps {
  siteName: string;
  cloudFrontDistributionProps?: DistributionProps
  cacheBehaviors: { [path: string]: AddBehaviorOptions }[];

  originAccessIdentity: OriginAccessIdentity
  webAcl?: cdk.aws_wafv2.CfnWebACL;

}
export class Site extends cdk.NestedStack {
  readonly siteName: string;
  readonly webAcl?: cdk.aws_wafv2.CfnWebACL;

  constructor(scope: CloudfrontS3StaticSitesStack, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    this.siteName = props.siteName;

    new Role(this, this.name('DeployerRole'), {
      roleName: this.name('DeployerRole'),
      assumedBy: new cdk.aws_iam.AccountRootPrincipal(),
    });

    const webContentBucket = new Bucket(this, this.name('webContent'), {
      bucketName: this.regionName('webContent-Bucket'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      lifecycleRules: [{
        noncurrentVersionTransitions: [{
          storageClass: StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90)
        }]
      }]
    });

    const accessLog = new Bucket(this, this.name(`accessLog`), {
      bucketName: this.regionName('accessLog-Bucket'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      accessControl: cdk.aws_s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      lifecycleRules: [{
        enabled: true,
        expiration: cdk.Duration.days(90),
        id: 'rule',
      }]
    })

    const webContentOrigin = new S3Origin(webContentBucket, {
      originAccessIdentity: props.originAccessIdentity
    });


    const responseHeadersPolicy = new ResponseHeadersPolicy(this, this.name('ResponseHeadersPolicy'), {
      responseHeadersPolicyName: this.name('ResponseHeadersPolicy'),
      comment: 'A policy for ' + this.name('ResponseHeadersPolicy'),
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
    new CloudFrontToS3(this, 'test', {})
    const distribution = new Distribution(this, this.name('CloudFront'), {
      defaultBehavior: {
        origin: webContentOrigin,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeadersPolicy,
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      enableIpv6: true,
      enabled: true,
      enableLogging: true,
      logBucket: accessLog,
      logFilePrefix: `accessLog/${this.siteName}`,
      webAclId: this.webAcl?.attrArn,
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_100,
      ...props.cloudFrontDistributionProps,
    });
    webContentBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [webContentBucket.arnForObjects('*')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${scope.account}:distribution/${distribution.distributionId}`
        }
      }
    }));
    //for each key/value in props.cacheBehaviors, add to the cloudfront distribution
    props.cacheBehaviors.forEach(behavior => {
      for (const [path, addBehaviorOptions] of Object.entries(behavior)) {
        distribution.addBehavior(path, webContentOrigin, addBehaviorOptions)
      }
    })

    new cdk.CfnOutput(this, this.name('CloudFrontURL-Output'), {
      value: distribution.domainName,
      description: `${this.siteName} CloudFront URL`,
      exportName: this.name('CloudFrontURL')
    })


    new cdk.CfnOutput(this, this.name('LoggingBucket-Output'), {
      value: accessLog.bucketArn,
      description: `${this.siteName} Logging bucket`,
      exportName: this.name('LoggingBucket')
    });
    new cdk.CfnOutput(this, this.name('SiteBucket-Output'), {
      value: webContentBucket.bucketArn,
      description: `${this.siteName} Site bucket`,
      exportName: this.name('SiteBucket')
    })
  }

  name(resourceName: string) {
    return `${this.siteName}-${resourceName}`.toLocaleLowerCase();
  }

  regionName(resourceName: string) {
    return `${this.name(resourceName)}-${this.account}`.toLocaleLowerCase();
  }
}
