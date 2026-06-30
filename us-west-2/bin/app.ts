#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { config } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DatabaseStack } from '../lib/database-stack';
import { EksStack } from '../lib/eks-stack';
import { CloudFrontStack } from '../lib/cloudfront-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

const prefix = config.project; // e.g. "keycloak-ha"

// 1) Network
const network = new NetworkStack(app, `${prefix}-network`, { env, config });

// 2) Database (Aurora PostgreSQL, Graviton)
const database = new DatabaseStack(app, `${prefix}-database`, {
  env,
  config,
  vpc: network.vpc,
});
database.addDependency(network);

// 3) EKS (cluster + ARM nodes + ALB + LB controller + Keycloak workload).
//    Depends on the database: reads its secret and opens 5432 from the node SG.
const eksStack = new EksStack(app, `${prefix}-eks`, {
  env,
  config,
  vpc: network.vpc,
  dbSecret: database.secret,
  dbWriterEndpoint: database.cluster.clusterEndpoint.hostname,
  dbSecurityGroupId: database.securityGroup.securityGroupId,
});
eksStack.addDependency(database);

// 4) CloudFront in front of the ALB.
const cloudfront = new CloudFrontStack(app, `${prefix}-cloudfront`, {
  env,
  config,
  alb: eksStack.alb,
});
cloudfront.addDependency(eksStack);

// Apply common tags to everything.
for (const [k, v] of Object.entries(config.tags)) {
  cdk.Tags.of(app).add(k, v);
}
