import * as cdk from 'aws-cdk-lib';
import { CachePolicy, CfnOriginAccessControl, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface CommonStackProps extends cdk.StackProps {

}

export class CommonStack extends cdk.Stack {
    readonly webAcl: CfnWebACL;
    readonly originAccessControl: CfnOriginAccessControl;
    readonly accessLog: Bucket;
    constructor(scope: Construct, id: string, props: CommonStackProps) {
        super(scope, id, props);
        this.originAccessControl = new CfnOriginAccessControl(this, 'S3AccessControl', {
            originAccessControlConfig: {
                name: 'S3AccessControl',
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',

                // the properties below are optional
                description: 'Allow cloudfront access to S3 buckets using Bucket Policies',
            },
        });


        this.accessLog = new Bucket(this, 'accessLog', {
            bucketName: `cloudfront-accessLog-${this.account}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            accessControl: cdk.aws_s3.BucketAccessControl.LOG_DELIVERY_WRITE,
            objectOwnership: cdk.aws_s3.ObjectOwnership.OBJECT_WRITER,
            lifecycleRules: [{
                enabled: true,
                expiration: cdk.Duration.days(90),
                id: 'rule',
            }]
        });

        this.webAcl = new CfnWebACL(this, `acl-1`, {
            defaultAction: { allow: {} },
            scope: 'REGIONAL',
            rules: [{
                name: 'CRSRule',
                priority: 0,
                statement: {
                    managedRuleGroupStatement: {
                        name: 'AWSManagedRulesCommonRuleSet',
                        vendorName: 'AWS'
                    }
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: 'MetricForWebACLCDK-CRS',
                    sampledRequestsEnabled: true,
                },
                overrideAction: {
                    none: {}
                },
            }
            ],
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `MetricForWebACLCDK`,
                sampledRequestsEnabled: true
            }
        })
    }
}
