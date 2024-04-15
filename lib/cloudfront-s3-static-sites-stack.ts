import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Site } from './Site';

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
      siteName: `VueJS-${this.deploymentEnv}`,
      origins:
      {
        '/sub-site/*': 'subsite'
      },
      dev: this.deploymentEnv === 'dev',
      urlPrefix: 'test',
      disableCache: true,
      originAccessControl: true

    });




  }
}
