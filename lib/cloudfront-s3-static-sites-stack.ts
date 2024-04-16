import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Site } from './Site';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';

export interface CloudfrontS3StaticSitesStackProps extends cdk.StackProps {
  deploymentEnv?: string;
  project: string
}

export class CloudfrontS3StaticSitesStack extends cdk.Stack {
  readonly deploymentEnv?: string;
  readonly project: string

  constructor(scope: Construct, id: string, props: CloudfrontS3StaticSitesStackProps) {
    super(scope, id, props);
    this.project = props.project;
    this.deploymentEnv = props?.deploymentEnv ?? 'dev';

    const site = new Site(this, {
      siteName: `abc-${this.deploymentEnv}`,
      origins:
      {
        '/site-a/*': 'sitea',
        '/site-b/*': 'siteb',
      },
      dev: this.deploymentEnv === 'dev',
      disableCache: true,
      originAccessControl: true
    });

    new BucketDeployment(this, 'default-deploy', {
      sources: [Source.asset('websites/default')],
      destinationBucket: site.defaultS3OriginBucket,
    })

    new BucketDeployment(this, 'site-a-deploy', {
      sources: [Source.asset('websites/site-a')],
      destinationBucket: site.s3OriginBuckets.sitea,
    })

    new BucketDeployment(this, 'site-b-deploy', {
      sources: [Source.asset('websites/site-b')],
      destinationBucket: site.s3OriginBuckets.siteb,
    })



  }
}
