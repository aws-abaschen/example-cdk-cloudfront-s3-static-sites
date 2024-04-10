import * as cdk from 'aws-cdk-lib';
import { BehaviorOptions, CachePolicy, CfnDistribution, CfnOriginAccessControl, Distribution, DistributionProps, HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BucketProps, StorageClass } from 'aws-cdk-lib/aws-s3';
import { CloudfrontS3StaticSitesStack } from './cloudfront-s3-static-sites-stack';

export interface OptionalBehaviorOptions extends Partial<cdk.aws_cloudfront.BehaviorOptions> {
  origin?: S3Origin
  cachePolicy?: CachePolicy
  responsePolicy?: ResponseHeadersPolicy
}

export interface DistributionOrigin {
  id: string
  bucket: Bucket
  behavior: BehaviorOptions
};

export interface OriginProps {
  id: string
  bucket?: Bucket
  behavior?: OptionalBehaviorOptions
}

export interface SiteProps extends cdk.NestedStackProps {
  siteName: string | {
    id: string
    bucket?: Bucket
    behavior?: OptionalBehaviorOptions
  }
  domain?: {
    domainName: string,
    altNames: string[],
    certificateArn: string
  },
  accessLogsBucketArn: string,
  cloudFrontDistributionProps?: DistributionProps
  origins: {
    [path: string]: string | OriginProps
  }

  originAccessControlId: string
  webAclArn?: string;

}

const contentBucketProps: Partial<BucketProps> = {
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

export class Site extends cdk.NestedStack {
  readonly siteName: string;

  constructor(scope: CloudfrontS3StaticSitesStack, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    if (typeof props.siteName === 'string') {
      this.siteName = props.siteName;
    } else {
      this.siteName = props.siteName.id;
    }
    const defaultBehaviorProps: OriginProps = { id: 'default' };

    const distributionOriginsOutput: { [path: string]: DistributionOrigin } = {};
    const additionalBehaviors: { [path: string]: cdk.aws_cloudfront.BehaviorOptions } = {};
    const defaultOrigin = this._createBehavior(defaultBehaviorProps, true);
    const accessLogBucket = Bucket.fromBucketArn(this, this.name('accessLog'), props.accessLogsBucketArn);
    // for each origin in props.origins, create bucket and S3Origin
    for (const [path, siteName] of Object.entries(props.origins)) {
      const output = this._createBehavior(siteName);
      distributionOriginsOutput[path] = output
      additionalBehaviors[path] = {
        ...output.behavior
      }
    }

    const distribution = new Distribution(this, this.name('CloudFront'), {
      defaultBehavior: defaultOrigin.behavior,
      additionalBehaviors: {
        ...additionalBehaviors,
      },
      defaultRootObject: 'index.html',
      enableIpv6: true,
      enabled: true,
      enableLogging: true,
      logBucket: accessLogBucket,
      logFilePrefix: `accessLog/${this.siteName}`,
      webAclId: props.webAclArn,
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_100,
      ...props.cloudFrontDistributionProps,
    });

    // Remove the old OriginAccessIdentity
    const cfnDistribution = distribution.node.defaultChild as CfnDistribution
    cfnDistribution.addOverride('Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', "")
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', props.originAccessControlId)
    distribution.node.findAll().filter((child) => child.node.id === 'S3Origin').map(c => c.node).forEach(node => node.tryRemoveChild('S3OriginConfig'));

    // for each webcontentBuckets add policy for cloudfront access
    for (const [path, { bucket, id }] of Object.entries(distributionOriginsOutput)) {
      let i = 1;
      const cfnDistribution = distribution.node.defaultChild as CfnDistribution
      cfnDistribution.addOverride(`Properties.DistributionConfig.Origins.${i}.S3OriginConfig.OriginAccessIdentity`, "")
      cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.${i}.OriginAccessControlId`, props.originAccessControlId)

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
      new cdk.CfnOutput(this, this.name(`${id}-Output`), {
        value: bucket.bucketArn,
        description: `${this.name(`${id}-arn`)} Site bucket`,
        exportName: this.name(`${id}-arn`)
      })
    }
    defaultOrigin.bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [defaultOrigin.bucket.arnForObjects('*')],
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

    new cdk.CfnOutput(this, this.name('SiteBucket-Output'), {
      value: defaultOrigin.bucket.bucketArn,
      description: `${this.name(`default`)} Site bucket`,
      exportName: this.name(`default-arn`)
    })
  }
  _createBehavior(param: string | OriginProps, skipId?: boolean): DistributionOrigin {
    const originProps = typeof param === 'string' ? { id: param } : { ...param };

    const webContentBucket = originProps.bucket ?? new Bucket(this, this.name(`webContent-${skipId ? 'default' : originProps.id}-Bucket`), {
      ...contentBucketProps,
      bucketName: skipId ? this.regionName(`webContent}`) : this.regionName(`webContent-${originProps.id}`),
    });
    const webContentOrigin = originProps.bucket && originProps.behavior?.origin ? originProps.behavior.origin : new S3Origin(webContentBucket, {
      originAccessIdentity: undefined
    });
    const cachePolicy = originProps.behavior?.cachePolicy ?? CachePolicy.CACHING_OPTIMIZED;
    const responseHeadersPolicy = originProps.behavior?.responsePolicy ?? ResponseHeadersPolicy.SECURITY_HEADERS;
    return {
      id: originProps.id,
      bucket: webContentBucket,
      behavior: {
        ...originProps.behavior,
        cachePolicy,
        responseHeadersPolicy,
        origin: webContentOrigin,
      }
    };
  }

  name(resourceName: string) {
    return `${this.siteName}-${resourceName}`.toLocaleLowerCase();
  }

  regionName(resourceName: string) {
    return `${this.name(resourceName)}-${this.account}`.toLocaleLowerCase();
  }
}
