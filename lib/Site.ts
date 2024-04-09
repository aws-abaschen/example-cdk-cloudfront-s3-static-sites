import * as cdk from 'aws-cdk-lib';
import { CachePolicy, CfnDistribution, CfnOriginAccessControl, Distribution, DistributionProps, HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, StorageClass } from 'aws-cdk-lib/aws-s3';
import { CloudfrontS3StaticSitesStack } from './cloudfront-s3-static-sites-stack';
// import * as sqs from 'aws-cdk-lib/aws-sqs';
export interface SiteProps extends cdk.NestedStackProps {
  siteName: string;
  cloudFrontDistributionProps?: DistributionProps
  origins: { [path: string]: string }

  originAccessControl: CfnOriginAccessControl
  webAcl?: cdk.aws_wafv2.CfnWebACL;

}
export class Site extends cdk.NestedStack {
  readonly siteName: string;
  readonly webAcl?: cdk.aws_wafv2.CfnWebACL;

  constructor(scope: CloudfrontS3StaticSitesStack, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    const contentBucketProps = {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      lifecycleRules: [{
        noncurrentVersionTransitions: [{
          storageClass: StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90)
        }]
      }]
    }
    this.siteName = props.siteName;
    const origins: { [path: string]: string } = props.origins
    const distributionOrigins: { [path: string]: { bucketName: string, bucket: Bucket, origin: S3Origin } } = {};
    const defaultWebContentBucket = new Bucket(this, this.name(`webContent-default-Bucket`), {
      ...contentBucketProps,
      bucketName: this.regionName(`webContent-default`),
    });
    const defaultWebContentOrigin = new S3Origin(defaultWebContentBucket, {
      originAccessIdentity: undefined
    });

    // for each origin in props.origins, create bucket and S3Origin
    for (const [path, siteName] of Object.entries(origins)) {
      const webContentBucket = new Bucket(this, this.name(`webContent-${siteName}-Bucket`), {
        ...contentBucketProps,
        bucketName: this.regionName(`webContent-${siteName}`),
      });
      const webContentOrigin = new S3Origin(webContentBucket, {
        originAccessIdentity: undefined
      });
      distributionOrigins[path] = {
        bucketName: siteName,
        bucket: webContentBucket,
        origin: webContentOrigin
      };
    }


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

    const distribution = new Distribution(this, this.name('CloudFront'), {
      defaultBehavior: {
        origin: defaultWebContentOrigin,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeadersPolicy,
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: distributionOrigins,
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
    const originAccessControlAttr = props.originAccessControl.getAtt('Id');
    const cfnDistribution = distribution.node.defaultChild as CfnDistribution
    cfnDistribution.addOverride('Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', "")
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', originAccessControlAttr)
    const s3OriginNode = distribution.node.findAll().filter((child) => child.node.id === 'S3Origin');
    s3OriginNode[0].node.tryRemoveChild('S3OriginConfig');

    // for each webcontentBuckets add policy for cloudfront access
    for (const [path, { bucket, bucketName }] of Object.entries(distributionOrigins)) {
      let i=1;
      const cfnDistribution = distribution.node.defaultChild as CfnDistribution
      cfnDistribution.addOverride(`Properties.DistributionConfig.Origins.${i}.S3OriginConfig.OriginAccessIdentity`, "")
      cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.${i}.OriginAccessControlId`, originAccessControlAttr)
      
      distribution.node.findAll().filter((child) => child.node.id === 'S3Origin').map(construct => construct.node).forEach(node => node.tryRemoveChild('S3OriginConfig'));
      bucket.addToResourcePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject'],
        principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${scope.account}:distribution/${distribution.distributionId}`
          }
        }
      }));
      new cdk.CfnOutput(this, this.name(`${bucketName}-Output`), {
        value: bucket.bucketArn,
        description: `${this.name(`${bucketName}-arn`)} Site bucket`,
        exportName: this.name(`${bucketName}-arn`)
      })
    }
    defaultWebContentBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [defaultWebContentBucket.arnForObjects('*')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${scope.account}:distribution/${distribution.distributionId}`
        }
      }
    }));

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
      value: defaultWebContentBucket.bucketArn,
      description: `${this.name(`default`)} Site bucket`,
      exportName: this.name(`default-arn`)
    })
  }

  name(resourceName: string) {
    return `${this.siteName}-${resourceName}`.toLocaleLowerCase();
  }

  regionName(resourceName: string) {
    return `${this.name(resourceName)}-${this.account}`.toLocaleLowerCase();
  }
}
