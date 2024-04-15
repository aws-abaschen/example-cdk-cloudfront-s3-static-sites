import { CfnOutput, Duration, NestedStack, NestedStackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { BehaviorOptions, CacheHeaderBehavior, CachePolicy, CfnCloudFrontOriginAccessIdentity, CfnDistribution, Distribution, DistributionProps, Function, FunctionCode, FunctionEventType, FunctionRuntime, OriginAccessIdentity, PriceClass, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket, BucketProps, CfnBucketPolicy, IBucket, ObjectOwnership, ReplaceKey, StorageClass } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface OptionalBehaviorOptions extends Partial<BehaviorOptions> {
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
  behavior?: OptionalBehaviorOptions,
}

const contentBucketProps = (dev?: boolean): Partial<BucketProps> => ({
  ...(dev ? {
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  } : {
    versioned: true,
    lifecycleRules: [{
      noncurrentVersionTransitions: [{
        storageClass: StorageClass.GLACIER,
        transitionAfter: Duration.days(90)
      }]
    }]
  }),

});

export interface SiteProps extends NestedStackProps {
  dev?: boolean,
  originAccessIdentity?: OriginAccessIdentity
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
  cloudFrontDistributionProps?: DistributionProps
  origins: {
    [path: string]: string | OriginProps
  }

}


export class Site extends NestedStack {
  readonly siteName: string;
  readonly accessLogBucket: IBucket;
  // flag for development website to allow quick deletion of buckets
  readonly dev: boolean;
  readonly originAccessIdentity: OriginAccessIdentity;
  cachePolicy: CachePolicy;

  constructor(scope: Construct, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    if (typeof props.siteName === 'string') {
      this.siteName = props.siteName;
    } else {
      this.siteName = props.siteName.id;
    }

    this.dev = !!props.dev
    this.cachePolicy = new CachePolicy(this, this.name('cachePolicy'), {
      cachePolicyName: this.name('cachePolicy'),
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: CacheHeaderBehavior.allowList('x-s3-origin')
    });
    this.accessLogBucket = new Bucket(this, this.name('accessLog'), {
      bucketName: this.regionName(`site-accesslog`),
      ...contentBucketProps(this.dev),
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    });
    const accessLogParams = {
      logBucket: this.accessLogBucket,
      logFilePrefix: `accessLog/${this.siteName}`,
    }
    this._grantLogAccess(accessLogParams.logBucket, accessLogParams.logFilePrefix);
    this.originAccessIdentity = props.originAccessIdentity ?? new OriginAccessIdentity(this, this.name('OAI'), {
      comment: this.siteName

    })
    const defaultBehaviorProps: OriginProps = { id: 'default' };

    const distributionOriginsOutput: { [path: string]: DistributionOrigin } = {};
    const additionalBehaviors: { [path: string]: BehaviorOptions } = {};
    const defaultOrigin = this._createBehavior(defaultBehaviorProps);
    let pathPrefixes: string[] = [];
    // for each origin in props.origins, create bucket and S3Origin
    for (const [path, siteName] of Object.entries(props.origins)) {
      const output = this._createBehavior(siteName, path);
      distributionOriginsOutput[path] = output
      additionalBehaviors[path] = {
        ...output.behavior
      }
      //only retrieve what's inside the /xxxxxx/ = xxxxxx
      pathPrefixes.push(path.split('/')[1]);
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

    defaultOrigin.behavior = {
      ...defaultOrigin.behavior,
      functionAssociations: [{
        function: new Function(this, this.name(`${defaultOrigin.id}-rewrite`), {
          code: FunctionCode.fromInline(`function handler(event) { if(!event.request.uri.match(/^\\/(${pathPrefixes.join('|')})$/)) return event.request; return {statusCode: 301,headers: {location: {value: event.request.uri.replace(/^\\/(${pathPrefixes.join('|')})$/, "/$1/")}}}}`),
          runtime: FunctionRuntime.JS_2_0,
        }),
        eventType: FunctionEventType.VIEWER_REQUEST,
      },
      ],
    }

    const distribution = new Distribution(this, this.name('CloudFront'), {
      defaultBehavior: defaultOrigin.behavior,
      additionalBehaviors: {
        ...additionalBehaviors,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(1),
          //responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        }
      ],
      defaultRootObject: 'index.html',
      enableIpv6: true,
      enabled: true,
      enableLogging: true,
      ...accessLogParams,
      //webAclId: props.webAclArn,
      priceClass: PriceClass.PRICE_CLASS_100,
      ...distributionProps,
    });

    // for each webcontentBuckets add policy for cloudfront access
    for (const [path, { bucket, id }] of Object.entries(distributionOriginsOutput)) {
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
      new CfnOutput(this, this.name(`${id}-Output`), {
        value: bucket.bucketArn,
        description: `${this.name(`${id}-arn`)} Site bucket`,
        exportName: this.name(`${id}-arn`)
      })
    }

    //distribution.node.findAll().filter((child) => child.node.id === 'S3Origin').map(construct => construct.node).forEach(node => node.tryRemoveChild('S3OriginConfig'));
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

    new CfnOutput(this, this.name('CloudFrontURL-Output'), {
      value: distribution.domainName,
      description: `${this.siteName} CloudFront URL`,
      exportName: this.name('CloudFrontURL')
    });

    new CfnOutput(this, this.name('SiteBucket-Output'), {
      value: defaultOrigin.bucket.bucketArn,
      description: `${this.name(`default`)} Site bucket`,
      exportName: this.name(`default-arn`)
    });

    //cleanup extra resources created by CF OAI
    this.node.children.forEach(resource => {
      //remove resource if instance of CfnCloudFrontOriginAccessIdentity
      if (resource instanceof CfnCloudFrontOriginAccessIdentity) {
        this.node.tryRemoveChild(resource.node.id)
      }
      if (resource instanceof CfnBucketPolicy) {
        this.node.tryRemoveChild(resource.node.id)
      }
    })
  }
  _grantLogAccess(bucket: IBucket, prefix: string) {
    this.accessLogBucket.addToResourcePolicy(new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [this.accessLogBucket.arnForObjects(ensureObjectPrefixWildcard(prefix))],
      //s3 log service
      principals: [new ServicePrincipal('logging.s3.amazonaws.com')],
      conditions: {
        ArnLike: {
          'aws:SourceArn': bucket.bucketArn
        }
      }
    }));
  }
  _createBehavior(param: string | OriginProps, path?: string): DistributionOrigin {
    const originProps = typeof param === 'string' ? { id: param } : { ...param };
    const isDefaultBehavior = !path;
    const serverAccessLogsPrefix = `bucketAccesslogs/${this.siteName}/${isDefaultBehavior ? 'default' : originProps.id}/`;


    const webContentBucket = originProps.bucket ?? new Bucket(this, this.name(`webContent${isDefaultBehavior ? '' : '-' + originProps.id}-Bucket`), {
      ...contentBucketProps(this.dev),
      //websiteIndexDocument: 'index.html',
      //websiteErrorDocument: 'index.html',
      bucketName: isDefaultBehavior ? this.regionName(`webContent`) : this.regionName(`webContent-${originProps.id}`),
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix
    });
    //this._grantLogAccess(webContentBucket, serverAccessLogsPrefix);
    const webContentOrigin = originProps.bucket && originProps.behavior?.origin ? originProps.behavior.origin : new S3Origin(webContentBucket, {
      originAccessIdentity: this.originAccessIdentity
    });
    webContentBucket.grantRead(this.originAccessIdentity);
    if (path) {

      //add a function to remove path when forwarding to Origin
      originProps.behavior = {
        ...originProps.behavior,
        functionAssociations: [{
          function: new Function(this, this.name(`${originProps.id}-rewrite`), {
            code: FunctionCode.fromInline(`function handler(event) { const request = event.request;request.headers['x-s3-origin']={value:'${originProps.id}'};request.uri = request.uri.replace(/^${path.replace(/\*$/, '').replaceAll('/', '\\/')}/, "/"); return request;}`),
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
        cachePolicy: this.cachePolicy,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
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

const ensureObjectPrefixWildcard = (prefix: string) => {
  //if prefix does not end with /, add one
  if (!prefix.endsWith('/')) {
    prefix += '/'
  }
  //if prefix does not end with a wildcard, add one
  if (!prefix.endsWith('*')) {
    prefix += '*'
  }
  return prefix;
}