import * as cdk from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { BehaviorOptions, CachePolicy, CfnDistribution, CfnOriginAccessControl, Distribution, DistributionProps, Function, FunctionCode, FunctionEventType, FunctionRuntime, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket, BucketProps, IBucket, StorageClass } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

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
    // either provide a hostedZone ID to validate a certificate
    hostedZoneId?: string,
    // or a certificate ARN directly
    certificateArn?: string
  },
  accessLogsBucketArn: string,
  cloudFrontDistributionProps?: DistributionProps
  origins: {
    [path: string]: string | OriginProps
  }

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
  readonly accessLogBucket: IBucket;

  constructor(scope: Construct, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    if (typeof props.siteName === 'string') {
      this.siteName = props.siteName;
    } else {
      this.siteName = props.siteName.id;
    }
    this.accessLogBucket = Bucket.fromBucketArn(this, this.name('accessLog'), props.accessLogsBucketArn);

    const defaultBehaviorProps: OriginProps = { id: 'default' };

    const distributionOriginsOutput: { [path: string]: DistributionOrigin } = {};
    const additionalBehaviors: { [path: string]: BehaviorOptions } = {};
    const defaultOrigin = this._createBehavior(defaultBehaviorProps);
    // for each origin in props.origins, create bucket and S3Origin
    for (const [path, siteName] of Object.entries(props.origins)) {
      const output = this._createBehavior(siteName, path);
      distributionOriginsOutput[path] = output
      additionalBehaviors[path] = {
        ...output.behavior
      }
    }
    const distributionProps = { ...props.cloudFrontDistributionProps };
    if (props.domain) {
      distributionProps.domainNames = [props.domain.domainName, ...props.domain.altNames];
      if (props.domain.hostedZoneId) {
        const hostedZone = HostedZone.fromHostedZoneId(this, this.name('hostedZone'), props.domain.hostedZoneId)
        distributionProps.certificate = new Certificate(this, this.name('certificate'), {
          domainName: props.domain.domainName,
          subjectAlternativeNames: [props.domain.domainName, ...props.domain.altNames],
          validation: CertificateValidation.fromDns(hostedZone)
        })
      } else {
        if (!props.domain.certificateArn) {
          throw new Error('Either a hostedZoneId or a certificateArn must be provided in the domain definition')
        }
        distributionProps.certificate = Certificate.fromCertificateArn(this, this.name('certificate'), props.domain.certificateArn);
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
      logBucket: this.accessLogBucket,
      logFilePrefix: `accessLog/${this.siteName}`,
      webAclId: props.webAclArn,
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_100,
      ...distributionProps,
    });

    const originAccessControl = new CfnOriginAccessControl(this, this.name('S3AccessControl'), {
      originAccessControlConfig: {
        name: this.name('S3AccessControl'),
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',

        // the properties below are optional
        description: 'Allow cloudfront access to S3 buckets using Bucket Policies',
      },
    });
    // Remove the old OriginAccessIdentity
    const cfnDistribution = distribution.node.defaultChild as CfnDistribution
    cfnDistribution.addOverride('Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', "")
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', originAccessControl.getAtt('Id'))
    distribution.node.findAll().filter((child) => child.node.id === 'S3Origin').map(c => c.node).forEach(node => node.tryRemoveChild('S3OriginConfig'));

    // for each webcontentBuckets add policy for cloudfront access
    for (const [path, { bucket, id }] of Object.entries(distributionOriginsOutput)) {
      let i = 1;
      const cfnDistribution = distribution.node.defaultChild as CfnDistribution
      cfnDistribution.addOverride(`Properties.DistributionConfig.Origins.${i}.S3OriginConfig.OriginAccessIdentity`, "")
      cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.${i}.OriginAccessControlId`, originAccessControl.getAtt('Id'))

      distribution.node.findAll().filter((child) => child.node.id === 'S3Origin').map(construct => construct.node).forEach(node => node.tryRemoveChild('S3OriginConfig'));
      bucket.addToResourcePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject'],
        principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`
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
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`
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
  _grantLogAccess(bucket: IBucket, prefix: string) {
    this.accessLogBucket.addToResourcePolicy(new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [this.accessLogBucket.arnForObjects(`${prefix}*`)],
      //s3 log service
      principals: [new cdk.aws_iam.ServicePrincipal('logging.s3.amazonaws.com')],
      conditions: {
        ArnLike: {
          'aws:SourceArn': bucket.bucketArn
        }
      }
    }));
  }
  _createBehavior(param: string | OriginProps, path?: string): DistributionOrigin {
    const originProps = typeof param === 'string' ? { id: param } : { ...param };
    const skipId = !path;
    const serverAccessLogsPrefix = `bucketAccesslogs/${this.siteName}/${skipId ? 'default' : originProps.id}/`;
    const webContentBucket = originProps.bucket ?? new Bucket(this, this.name(`webContent${skipId ? '' : '-' + originProps.id}-Bucket`), {
      ...contentBucketProps,
      bucketName: skipId ? this.regionName(`webContent`) : this.regionName(`webContent-${originProps.id}`),
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix
    });
    this._grantLogAccess(webContentBucket, serverAccessLogsPrefix);
    const webContentOrigin = originProps.bucket && originProps.behavior?.origin ? originProps.behavior.origin : new S3Origin(webContentBucket, {
      originAccessIdentity: undefined,
      originId: this.name(`orig-${originProps.id}`)
    });
    if (path) {

      //add a function to remove path when forwarding to Origin
      originProps.behavior = {
        ...originProps.behavior,
        functionAssociations: [{
          function: new Function(this, this.name(`${originProps.id}-rewrite`), {
            code: FunctionCode.fromInline(`function handler(event) { const request = event.request;request.uri = request.uri.replace(/^${path.replace(/\*$/, '').replaceAll('/', '\\/')}/, "/"); return request;}`),
            runtime: FunctionRuntime.JS_2_0,
          }),
          eventType: FunctionEventType.VIEWER_REQUEST,
        },
        ...(originProps.behavior?.functionAssociations ?? [])
        ],
      }
    }

    return {
      id: originProps.id,
      bucket: webContentBucket,
      behavior: {
        //default values
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        ...originProps.behavior,
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
