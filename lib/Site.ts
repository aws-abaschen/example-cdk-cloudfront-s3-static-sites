import { CfnOutput, Duration, NestedStack, NestedStackProps, RemovalPolicy, aws_cloudfront } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { BehaviorOptions, CacheHeaderBehavior, CachePolicy, CfnCloudFrontOriginAccessIdentity, CfnDistribution, CfnOriginAccessControl, Distribution, DistributionProps, Function, FunctionCode, FunctionEventType, FunctionRuntime, ICachePolicy, OriginAccessIdentity, PriceClass, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket, BucketProps, IBucket, ObjectOwnership, StorageClass } from 'aws-cdk-lib/aws-s3';
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
  disableCache?: boolean,
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
  originAccessControl?: boolean,
  urlPrefix?: string,
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
  readonly originAccessIdentity: OriginAccessIdentity | undefined;
  readonly originAccessControlId: string | undefined
  readonly cachePolicy: ICachePolicy;
  readonly urlPrefix?: string;
  readonly s3originResponseSPA: aws_cloudfront.experimental.EdgeFunction
  readonly s3originRequestSPA: aws_cloudfront.experimental.EdgeFunction

  readonly cloudFrontDistribution: Distribution;
  readonly defaultS3OriginBucket: IBucket;
  readonly s3OriginBuckets: { [key: string]: IBucket }

  constructor(scope: Construct, props: SiteProps) {
    super(scope, `${props.siteName}-Site`, props);

    if (typeof props.siteName === 'string') {
      this.siteName = props.siteName;
    } else {
      this.siteName = props.siteName.id;
    }

    this.dev = !!props.dev
    this.urlPrefix = props.urlPrefix;
    this.cachePolicy = props.disableCache ? CachePolicy.CACHING_DISABLED : new CachePolicy(this, 'cachePolicy', {
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: CacheHeaderBehavior.allowList('x-s3-origin')
    });
    this.accessLogBucket = new Bucket(this, 'accessLog', {
      ...contentBucketProps(this.dev),
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    });
    new CfnOutput(this, `Bucket-AccessLog-Output`, {
      value: this.accessLogBucket.bucketArn,
      description: `AccessLog bucket for ${this.siteName} distribution and S3 Buckets`,
    });
    const accessLogParams = {
      logBucket: this.accessLogBucket,
      logFilePrefix: `accessLog/${this.siteName}`,
    }
    this._grantLogAccess(accessLogParams.logBucket, accessLogParams.logFilePrefix);
    if (props.originAccessControl) {
      const originAccessControl = new CfnOriginAccessControl(this, 'S3AccessControl', {
        originAccessControlConfig: {
          name: `${this.siteName}-${props.dev ? 'dev' : 'prod'}-OAC`,
          originAccessControlOriginType: 's3',
          signingBehavior: 'always',
          signingProtocol: 'sigv4',

          // the properties below are optional
          description: 'Allow cloudfront access to S3 buckets using Bucket Policies',
        },
      });
      this.originAccessControlId = originAccessControl.attrId;
      this.originAccessIdentity = undefined
    } else {
      this.originAccessIdentity = new OriginAccessIdentity(this, 'OAI', {
        comment: this.siteName

      })
    }
    const defaultBehaviorProps: OriginProps = { id: 'default' };


    const distributionOriginsOutput: { [path: string]: DistributionOrigin } = {};
    const additionalBehaviors: { [path: string]: BehaviorOptions } = {};
    const defaultOrigin = this._createBehavior(defaultBehaviorProps);
    this.defaultS3OriginBucket = defaultOrigin.bucket;
    this.s3OriginBuckets = {};
    let pathPrefixes: string[] = [];


    // for each origin in props.origins, create bucket and S3Origin
    for (const [path, siteName] of Object.entries(props.origins)) {
      const output = this._createBehavior(siteName, path);
      distributionOriginsOutput[path] = output
      additionalBehaviors[path] = {
        ...output.behavior
      }
      this.s3OriginBuckets[output.id] = output.bucket;
      //only retrieve what's inside the /xxxxxx/ = xxxxxx
      pathPrefixes.push(path.split('/')[1]);
    }
    defaultOrigin.behavior = {
      ...defaultOrigin.behavior,
      functionAssociations: [
        {
          function: new Function(this, `fn-rewrite-default`, {
            code:
              FunctionCode.fromInline(`
                let subsiteRegexp = /^\\/(${pathPrefixes.join('|')})\\/(?:[^\\/]+\\/)*([^\\/]*)(\\.\\w{1,5})?$/;
                function handler(event) {
                    console.log(event);
                    const groups = event.request.uri.match(subsiteRegexp);
                    if (!groups) {
                        return event.request;
                    }
                    const originTarget = groups[1];
                    const resourceUri = groups[2] || '';
  
                    if (groups[0].match(/^\\/(${pathPrefixes.join('|')})$/)) {
                      return { statusCode: 301, headers: { location: { value: event.request.uri + '/' } } };
                    }

                    if (!resourceUri.match(/.*\\.\\w{1,5}/)) { //doesn't route to asset
                        event.request.uri = '/index.html';
                        return event.request;
                    }
                    event.request.uri = groups[0].replace(/^\\/(${pathPrefixes.join('|')})/, '')
  
                    return event.request;
                }`),
            runtime: FunctionRuntime.JS_2_0,
          }),
          eventType: FunctionEventType.VIEWER_REQUEST,
        }

      ]
    }

    const distributionProps = { ...props.cloudFrontDistributionProps };
    if (props.domain) {
      distributionProps.domainNames = [props.domain.domainName, ...props.domain.altNames];
      if (props.domain.hostedZoneId) {
        const hostedZone = HostedZone.fromHostedZoneId(this, 'hostedZone', props.domain.hostedZoneId)
        distributionProps.certificate = new Certificate(this, 'distribution-certificate', {
          domainName: props.domain.domainName,
          subjectAlternativeNames: [props.domain.domainName, ...props.domain.altNames],
          validation: CertificateValidation.fromDns(hostedZone)
        })
      } else {
        if (!props.domain.certificateArn) {
          throw new Error('Either a hostedZoneId or a certificateArn must be provided in the domain definition')
        }
        distributionProps.certificate = Certificate.fromCertificateArn(this, 'distribution-certificate', props.domain.certificateArn);
      }
    }

    this.cloudFrontDistribution = new Distribution(this, 'distribution', {
      defaultBehavior: defaultOrigin.behavior,
      additionalBehaviors: {
        ...additionalBehaviors,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: `/${this.urlPrefix ? this.urlPrefix + '/' : ''}index.html`,
          ttl: Duration.minutes(1),
          //responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: `/${this.urlPrefix ? this.urlPrefix + '/' : ''}index.html`,
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

    if (this.originAccessControlId) {
      const cfnDistribution = this.cloudFrontDistribution.node.defaultChild as CfnDistribution
      cfnDistribution.addOverride(`Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity`, "")
      //cfnDistribution.addDeletionOverride(`Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity`)
      cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.0.OriginAccessControlId`, this.originAccessControlId)


      let i = 1;
      // for each webcontentBuckets add policy for cloudfront access
      for (const [path, { bucket, id }] of Object.entries(distributionOriginsOutput)) {

        bucket.addToResourcePolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['s3:GetObject'],
          principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
          resources: [bucket.arnForObjects('*')],
          conditions: {
            StringEquals: {
              'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${this.cloudFrontDistribution.distributionId}`
            }
          }
        }));
        //we are just using the index, might not be the same order
        cfnDistribution.addOverride(`Properties.DistributionConfig.Origins.${i}.S3OriginConfig.OriginAccessIdentity`, "");
        cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.${i}.OriginAccessControlId`, this.originAccessControlId);
        i++;
      }

      //cleanup extra resources created by CF OAI
      this.node.children.forEach(resource => {
        //remove resource if instance of CfnCloudFrontOriginAccessIdentity
        if (resource instanceof CfnCloudFrontOriginAccessIdentity) {
          this.node.tryRemoveChild(resource.node.id)
        }
      })
    }

    defaultOrigin.bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [defaultOrigin.bucket.arnForObjects('*')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${this.cloudFrontDistribution.distributionId}`
        }
      }
    }));

    new CfnOutput(this, 'CloudFrontURL-Output', {
      value: this.cloudFrontDistribution.domainName,
      description: `${this.siteName} CloudFront URL`,
    });

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
    const originId = isDefaultBehavior ? 'default' : originProps.id;
    const serverAccessLogsPrefix = `bucket/${originId}/`;


    const webContentBucket = originProps.bucket ?? new Bucket(this, `webContent${originId}-Bucket`, {
      ...contentBucketProps(this.dev),
      //websiteIndexDocument: 'index.html',
      //websiteErrorDocument: 'index.html',
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix
    });
    new CfnOutput(this, `Bucket-${originId}-Output`, {
      value: webContentBucket.bucketArn,
      description: `${originId} Site bucket`,
    });
    //this._grantLogAccess(webContentBucket, serverAccessLogsPrefix);
    const webContentOrigin = originProps.bucket && originProps.behavior?.origin ? originProps.behavior.origin : new S3Origin(webContentBucket, {
      ...(this.originAccessIdentity
        ? {
          originAccessIdentity: this.originAccessIdentity,
          originId
        }
        : {
          originAccessIdentity: undefined,
          originId
        })
    });

    if (this.originAccessIdentity)
      webContentBucket.grantRead(this.originAccessIdentity);

    const originResult = {
      id: originId,
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

    if (!isDefaultBehavior) {
      const originPathClean = path.substring(1, path.length - 2).replaceAll('/', '\\/')
      return {
        ...originResult,
        behavior: {
          ...originResult.behavior,
          functionAssociations: [
            {
              function: new Function(this, `fn-rewrite-${originPathClean.replaceAll('/', '-')}`, {
                code:
                  FunctionCode.fromInline(`
                let subsiteRegexp = /^\\/(${originPathClean})\\/(?:[^\\/]+\\/)*([^\\/]*)(\\.\\w{1,5})?$/;
                function handler(event) {
                    console.log(event);
                    const groups = event.request.uri.match(subsiteRegexp);
                    if (!groups) {
                        return event.request;
                    }
                    const originTarget = groups[1];
                    const resourceUri = groups[2] || '';
  
                    if (groups[0].match(/^\\/(${originPathClean})$/)) {
                      return { statusCode: 301, headers: { location: { value: event.request.uri + '/' } } };
                    }

                    if (!resourceUri.match(/.*\\.\\w{1,5}/)) { //doesn't route to asset
                        event.request.uri = '/index.html';
                        return event.request;
                    }
                    event.request.uri = groups[0].replace(/^\\/(${originPathClean})/, '')
  
                    return event.request;
                }`),
                runtime: FunctionRuntime.JS_2_0,
              }),
              eventType: FunctionEventType.VIEWER_REQUEST,
            }

          ]
        }
      }
    }

    return originResult;
  }

  regionName(resourceName: string) {
    return `${resourceName}-${this.account}`.toLocaleLowerCase();
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