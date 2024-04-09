import * as cdk from 'aws-cdk-lib';
import { CachePolicy, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface CommonStackProps extends cdk.StackProps {
}

export class CommonStack extends cdk.Stack {
    readonly webAcl: CfnWebACL;
    readonly originAccessIdentity: OriginAccessIdentity;

    constructor(scope: Construct, id: string, props: CommonStackProps) {
        super(scope, id, props);
        this.originAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity', /* all optional props */ {
            comment: 'OriginAccessIdentity for WebSites',
          });

        this.webAcl = new CfnWebACL(this, `acl-1`, {
            defaultAction: { allow: {} },
            scope: 'REGIONAL',
            rules: [{
                name: 'CRSRule',
                priority: 0,
                statement: {
                  managedRuleGroupStatement: {
                    name:'AWSManagedRulesCommonRuleSet',
                    vendorName:'AWS'
                  }
                },
                visibilityConfig: {
                  cloudWatchMetricsEnabled: true,
                  metricName:'MetricForWebACLCDK-CRS',
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
