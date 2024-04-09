import * as cdk from 'aws-cdk-lib';
import { CachePolicy, CfnOriginAccessControl, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface CommonStackProps extends cdk.StackProps {
}

export class CommonStack extends cdk.Stack {
    readonly webAcl: CfnWebACL;
    readonly originAccessControl: CfnOriginAccessControl;

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
