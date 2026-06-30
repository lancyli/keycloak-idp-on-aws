import { Stack, StackProps, Duration, RemovalPolicy, Tags, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { KeycloakHaConfig } from './config';

/**
 * DatabaseStack provisions Aurora PostgreSQL on Graviton (ARM) as Keycloak's
 * persistence layer - replacing the demo's ephemeral H2 database.
 *
 * - Writer + N readers spread across AZs (Multi-AZ failover).
 * - Storage encrypted with AWS-managed KMS key.
 * - Credentials generated and stored in Secrets Manager.
 * - Lives in isolated subnets; only the EKS node SG may reach port 5432.
 */
export interface DatabaseStackProps extends StackProps {
  readonly config: KeycloakHaConfig;
  readonly vpc: ec2.IVpc;
}

export class DatabaseStack extends Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: secretsmanager.ISecret;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly port: number = 5432;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    this.securityGroup = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Aurora PostgreSQL - ingress only from EKS nodes on 5432',
      allowAllOutbound: false,
    });

    const parameterGroup = new rds.ParameterGroup(this, 'ClusterPg', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of(config.aurora.engineVersion, '16'),
      }),
      parameters: {
        // Enforce TLS for client connections to the database.
        'rds.force_ssl': '1',
      },
    });

    const instanceType = new ec2.InstanceType(config.aurora.instanceClass); // e.g. r7g.large

    const readers = [];
    for (let i = 0; i < config.aurora.readers; i++) {
      readers.push(
        rds.ClusterInstance.provisioned(`reader${i + 1}`, {
          instanceType,
          enablePerformanceInsights: true,
        }),
      );
    }

    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of(config.aurora.engineVersion, '16'),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      parameterGroup,
      writer: rds.ClusterInstance.provisioned('writer', {
        instanceType,
        enablePerformanceInsights: true,
      }),
      readers,
      defaultDatabaseName: config.aurora.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret('kcadmin', {
        secretName: `${config.project}/aurora/credentials`,
      }),
      storageEncrypted: true,
      backup: {
        retention: Duration.days(config.aurora.backupRetentionDays),
        preferredWindow: '16:00-17:00', // UTC (~09:00 PT)
      },
      cloudwatchLogsExports: ['postgresql'],
      deletionProtection: config.aurora.deletionProtection,
      removalPolicy: config.aurora.deletionProtection
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });

    this.secret = this.cluster.secret!;

    new CfnOutput(this, 'AuroraWriterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora writer endpoint',
    });
    new CfnOutput(this, 'AuroraSecretArn', {
      value: this.secret.secretArn,
      description: 'Secrets Manager ARN with Aurora credentials',
    });

    Tags.of(this).add('Component', 'database');
  }

  /** Allow a security group (EKS nodes) to connect to Aurora on 5432. */
  public allowFrom(peer: ec2.IPeer, description: string): void {
    this.securityGroup.addIngressRule(peer, ec2.Port.tcp(this.port), description);
  }
}
