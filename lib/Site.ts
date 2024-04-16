import { CfnOutput, Duration, Fn, NestedStack, NestedStackProps, RemovalPolicy, aws_cloudfront } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { BehaviorOptions, CacheHeaderBehavior, CachePolicy, CfnCloudFrontOriginAccessIdentity, CfnDistribution, CfnOriginAccessControl, Distribution, DistributionProps, Function, FunctionCode, FunctionEventType, FunctionRuntime, ICachePolicy, LambdaEdgeEventType, OriginAccessIdentity, PriceClass, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
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
  readonly s3originRedirectForSPA: aws_cloudfront.experimental.EdgeFunction
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
    this.cachePolicy = props.disableCache ? CachePolicy.CACHING_DISABLED : new CachePolicy(this, this.name('cachePolicy'), {
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
    if (props.originAccessControl) {
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
      this.originAccessControlId = originAccessControl.attrId;
      this.originAccessIdentity = undefined
    } else {
      this.originAccessIdentity = new OriginAccessIdentity(this, this.name('OAI'), {
        comment: this.siteName

      })
    }
    const defaultBehaviorProps: OriginProps = { id: 'default' };
    const executionRole = new Role(this, this.name('executionRole'), {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });


    new LogGroup(this, this.name('lg-request'), {
      logGroupName: '/aws/lambda/' + this.name('s3originRedirectForSPA'),
    })
    this.s3originRedirectForSPA = new aws_cloudfront.experimental.EdgeFunction(this, this.name('rn-redirect'), {
      runtime: Runtime.NODEJS_LATEST,
      handler: 'index.handler',
      functionName: this.name('s3originRedirectForSPA'),
      role: executionRole,
      code: Code.fromAsset('./lib/spa-request-origin')
    });
    
    //executionRole.grantAssumeRole(new ServicePrincipal('edgelambda.amazonaws.com'))
    executionRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'lambda:GetFunction',
        'lambda:EnableReplication*',
        'lambda:DisableReplication*',
      ],
      resources: ['*'],
    }))

    
    new LogGroup(this, this.name('lg-response'), {
      logGroupName: '/aws/lambda/' + this.name('origin-response'),
    })
    this.s3originRedirectForSPA = new aws_cloudfront.experimental.EdgeFunction(this, this.name('fn-response'), {
      runtime: Runtime.NODEJS_LATEST,
      handler: 'index.handler',
      functionName: this.name('origin-response'),
      role: executionRole,
      code: Code.fromAsset('./lib/spa-response-origin')
    });

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

    if (pathPrefixes.length > 0 || this.urlPrefix) {

      defaultOrigin.behavior = {
        ...defaultOrigin.behavior,
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: this.s3originRedirectForSPA.currentVersion
          }
        ],
        functionAssociations: [{
          function: new Function(this, this.name(`${defaultOrigin.id}-rewrite`), {
            functionName: 'appendTrailingSlash',
            code:
              FunctionCode.fromInline(`function handler(event) {
                    console.log(event);
                    let subsites = "${pathPrefixes.join('|')}";
                    if(subsites !==''){
                    let subsiteWithoutTrailingSlash = new RegExp("^\\/("+subsites+")$");
                    if(event.request.uri.match(subsiteWithoutTrailingSlash)){
                        return {statusCode: 301,headers: {location: {value: event.request.uri.replace(subsiteWithoutTrailingSlash, "/$1/")}}};
                    }
                    }
                    return event.request;
                }`),
            runtime: FunctionRuntime.JS_2_0,
          }),
          eventType: FunctionEventType.VIEWER_REQUEST,
        }]
      }
    }
    this.cloudFrontDistribution = new Distribution(this, this.name('CloudFront'), {
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

    new CfnOutput(this, this.name('CloudFrontURL-Output'), {
      value: this.cloudFrontDistribution.domainName,
      description: `${this.siteName} CloudFront URL`,
      exportName: this.name('CloudFrontURL')
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
    const serverAccessLogsPrefix = `bucketAccesslogs/${this.siteName}/${isDefaultBehavior ? 'default' : originProps.id}/`;


    const webContentBucket = originProps.bucket ?? new Bucket(this, this.name(`webContent${isDefaultBehavior ? '' : '-' + originProps.id}-Bucket`), {
      ...contentBucketProps(this.dev),
      //websiteIndexDocument: 'index.html',
      //websiteErrorDocument: 'index.html',
      bucketName: isDefaultBehavior ? this.regionName(`webContent`) : this.regionName(`webContent-${originProps.id}`),
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix
    });
    new CfnOutput(this, this.name(`Bucket-${originProps.id}-Output`), {
      value: webContentBucket.bucketArn,
      description: `${this.name(`${originProps.id}-arn`)} Site bucket`,
      exportName: this.name(`${originProps.id}-arn`)
    });
    //this._grantLogAccess(webContentBucket, serverAccessLogsPrefix);
    const webContentOrigin = originProps.bucket && originProps.behavior?.origin ? originProps.behavior.origin : new S3Origin(webContentBucket, {
      ...(this.originAccessIdentity
        ? {
          originAccessIdentity: this.originAccessIdentity
        }
        : {
          originAccessIdentity: undefined,
          originId: this.name(`orig-${originProps.id}`)
        })
    });
    if (this.originAccessIdentity)
      webContentBucket.grantRead(this.originAccessIdentity);
    //only accepts one level
    //TODO add multiple levels
    const root = this.urlPrefix ? this.urlPrefix.replace(/\/?([a-zA-Z0-9-]+)\/?/, '$1') : '';
    const normalizedPath = path ? path.replace(/\/?([a-zA-Z0-9-]+)\/?\*?/, '$1') : '';
    const fullPrefix = root + normalizedPath;
    console.log(fullPrefix);

    //add a function to remove path when forwarding to Origin
    originProps.behavior = {
      ...originProps.behavior,
      edgeLambdas: [{
        eventType: aws_cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
        functionVersion: this.s3originRedirectForSPA.currentVersion
      }]
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