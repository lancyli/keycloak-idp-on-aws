#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { config } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DatabaseStack } from '../lib/database-stack';
import { EksStack } from '../lib/eks-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region, // cn-northwest-1 -> CDK applies the aws-cn partition automatically
};

const prefix = config.project; // "keycloak-ha-cn"

// 1) Network
const network = new NetworkStack(app, `${prefix}-network`, { env, config });

// 2) Database (Aurora PostgreSQL, Graviton)
const database = new DatabaseStack(app, `${prefix}-database`, {
  env,
  config,
  vpc: network.vpc,
});
database.addDependency(network);

// 3) EKS + public ALB + Keycloak workload (no CloudFront in the ZHY variant)
const eksStack = new EksStack(app, `${prefix}-eks`, {
  env,
  config,
  vpc: network.vpc,
  dbSecret: database.secret,
  dbWriterEndpoint: database.cluster.clusterEndpoint.hostname,
  dbSecurityGroupId: database.securityGroup.securityGroupId,
});
eksStack.addDependency(database);

for (const [k, v] of Object.entries(config.tags)) {
  cdk.Tags.of(app).add(k, v);
}
