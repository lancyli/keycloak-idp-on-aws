import { Stack, StackProps, Duration, Tags, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { KubectlV35Layer } from '@aws-cdk/lambda-layer-kubectl-v35';
import { Construct } from 'constructs';
import { KeycloakHaConfig } from './config';
import { KeycloakWorkload } from './keycloak-workload';

/**
 * EksStack provisions:
 *   - An EKS cluster (control plane) running on Graviton worker nodes (AL2023 ARM64).
 *   - AWS Load Balancer Controller (for TargetGroupBinding) via the built-in addon.
 *   - Secrets Store CSI Driver + AWS provider (to mount the Aurora secret into pods).
 *   - A CDK-managed internet-facing ALB whose ingress is locked to the CloudFront
 *     origin-facing managed prefix list, plus an IP target group that Keycloak pods
 *     bind to via a TargetGroupBinding CRD.
 *
 * The ALB is created here (not by an Ingress) so its DNS name is known at synth time
 * and can be used directly as the CloudFront origin - avoiding a circular dependency.
 */
export interface EksStackProps extends StackProps {
  readonly config: KeycloakHaConfig;
  readonly vpc: ec2.IVpc;
  /** Aurora secret (Secrets Manager) consumed by Keycloak via Secrets Store CSI. */
  readonly dbSecret: secretsmanager.ISecret;
  /** Aurora writer endpoint hostname. */
  readonly dbWriterEndpoint: string;
  /** Aurora security group id, so EKS nodes can be granted 5432 ingress. */
  readonly dbSecurityGroupId: string;
}

export class EksStack extends Stack {
  public readonly cluster: eks.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  /** Cluster security group attached to pods/nodes (for DB ingress wiring). */
  public readonly clusterSecurityGroupId: string;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);
    const { config, vpc, dbSecret, dbWriterEndpoint, dbSecurityGroupId } = props;

    // ---- EKS cluster -------------------------------------------------------
    const endpointAccess =
      config.eks.publicEndpointAllowedCidrs.length > 0
        ? eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(
            ...config.eks.publicEndpointAllowedCidrs,
          )
        : eks.EndpointAccess.PUBLIC_AND_PRIVATE;

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: config.eks.clusterName,
      version: eks.KubernetesVersion.of(config.eks.version),
      kubectlLayer: new KubectlV35Layer(this, 'KubectlLayer'),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0, // we add an explicit ARM managed node group below
      endpointAccess,
      // Built-in AWS Load Balancer Controller (provides TargetGroupBinding CRD).
      albController: {
        version: eks.AlbControllerVersion.V2_17_1,
      },
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
      ],
    });

    // ---- ARM (Graviton) managed node group ---------------------------------
    const nodeGroup = this.cluster.addNodegroupCapacity('ArmNodeGroup', {
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD,
      instanceTypes: config.eks.nodeInstanceTypes.map((t) => new ec2.InstanceType(t)),
      minSize: config.eks.nodeMinSize,
      desiredSize: config.eks.nodeDesiredSize,
      maxSize: config.eks.nodeMaxSize,
      diskSize: config.eks.nodeDiskSizeGiB,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityType: eks.CapacityType.ON_DEMAND,
      labels: { workload: 'keycloak' },
    });

    // ---- Grant cluster-admin to operator principals ------------------------
    // Accepts both IAM Role and IAM User ARNs. Each entry gets a unique construct
    // id (indexed) so multiple admins can be supplied without collisions.
    config.eks.clusterAdminPrincipalArns.forEach((arn, i) => {
      if (arn.includes(':user/')) {
        this.cluster.awsAuth.addUserMapping(
          iam.User.fromUserArn(this, `AdminUser${i}`, arn),
          { groups: ['system:masters'] },
        );
      } else {
        this.cluster.awsAuth.addMastersRole(
          iam.Role.fromRoleArn(this, `AdminRole${i}`, arn, { mutable: false }),
        );
      }
    });

    // ---- EKS managed add-ons ------------------------------------------------
    // Register the core components as EKS-managed add-ons so they appear in the
    // console "Add-ons" tab and can be one-click upgraded (and auto version-checked
    // against the cluster K8s version on future upgrades).
    //
    // These components were installed as SELF-MANAGED defaults when the cluster
    // was bootstrapped, so `resolveConflicts: OVERWRITE` is required for the
    // managed add-on to adopt/overwrite the existing self-managed resources.
    // addonVersion is intentionally omitted so EKS selects the default version
    // that is compatible with the cluster's Kubernetes version.
    new eks.CfnAddon(this, 'VpcCniAddon', {
      clusterName: this.cluster.clusterName,
      addonName: 'vpc-cni',
      resolveConflicts: 'OVERWRITE',
    });
    new eks.CfnAddon(this, 'KubeProxyAddon', {
      clusterName: this.cluster.clusterName,
      addonName: 'kube-proxy',
      resolveConflicts: 'OVERWRITE',
    });
    const coreDnsAddon = new eks.CfnAddon(this, 'CoreDnsAddon', {
      clusterName: this.cluster.clusterName,
      addonName: 'coredns',
      resolveConflicts: 'OVERWRITE',
    });
    // CoreDNS pods must schedule onto worker nodes, so wait for the node group.
    coreDnsAddon.node.addDependency(nodeGroup);

    // metrics-server: required for CPU-based HorizontalPodAutoscaler (HPA) to
    // read pod metrics. Without it, the Keycloak HPA reports cpu:<unknown> and
    // never scales. Also depends on the node group so its pods can schedule.
    const metricsServerAddon = new eks.CfnAddon(this, 'MetricsServerAddon', {
      clusterName: this.cluster.clusterName,
      addonName: 'metrics-server',
      resolveConflicts: 'OVERWRITE',
    });
    metricsServerAddon.node.addDependency(nodeGroup);

    // ---- Secrets Store CSI Driver + AWS provider ---------------------------
    const csiDriver = this.cluster.addHelmChart('SecretsStoreCsiDriver', {
      chart: 'secrets-store-csi-driver',
      repository: 'https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts',
      release: 'csi-secrets-store',
      namespace: 'kube-system',
      version: '1.4.6',
      values: {
        syncSecret: { enabled: true },
        enableSecretRotation: true,
        rotationPollInterval: '2m',
      },
    });

    const awsProvider = this.cluster.addHelmChart('SecretsStoreAwsProvider', {
      chart: 'secrets-store-csi-driver-provider-aws',
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      release: 'secrets-provider-aws',
      namespace: 'kube-system',
      version: '0.3.10',
    });
    awsProvider.node.addDependency(csiDriver);

    // ---- ALB security group, locked to CloudFront origin-facing prefix list -
    // Look up the regional CloudFront origin-facing managed prefix list id.
    const cfPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: ['com.amazonaws.global.cloudfront.origin-facing'],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing-pl'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const cfPrefixListId = cfPrefixList.getResponseField('PrefixLists.0.PrefixListId');

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'ALB - ingress restricted to the CloudFront origin-facing prefix list',
    });
    // CloudFront -> ALB over HTTP (no custom domain). User -> CloudFront stays HTTPS.
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cfPrefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing to ALB (HTTP origin)',
    );
    // When a custom domain + ACM cert is configured, allow HTTPS origin too.
    if (config.cloudfront.customDomain.enabled) {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(cfPrefixListId),
        ec2.Port.tcp(443),
        'CloudFront origin-facing to ALB (HTTPS origin)',
      );
    }

    // ---- ALB + target group ------------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(120),
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'KeycloakTg', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP, // EKS pods registered by the LB controller
      healthCheck: {
        path: '/health/ready',
        port: '9000', // Keycloak management port
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
      stickinessCookieDuration: Duration.hours(1), // keep auth flow on one pod
    });

    const listenerProps: elbv2.BaseApplicationListenerProps = config.cloudfront
      .customDomain.enabled
      ? {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          // Do NOT auto-open 0.0.0.0/0; ingress is restricted to the CloudFront
          // origin-facing prefix list on the ALB security group.
          open: false,
          certificates: config.cloudfront.customDomain.albCertArnUsWest2
            ? [
                elbv2.ListenerCertificate.fromArn(
                  config.cloudfront.customDomain.albCertArnUsWest2,
                ),
              ]
            : undefined,
          defaultTargetGroups: [this.targetGroup],
        }
      : {
          port: 80,
          protocol: elbv2.ApplicationProtocol.HTTP,
          // Do NOT auto-open 0.0.0.0/0; ingress is restricted to the CloudFront
          // origin-facing prefix list on the ALB security group.
          open: false,
          defaultTargetGroups: [this.targetGroup],
        };
    this.alb.addListener('Listener', listenerProps);

    // ---- Allow ALB -> pods on the cluster security group -------------------
    this.clusterSecurityGroupId = this.cluster.clusterSecurityGroupId;
    const clusterSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ClusterSgRef',
      this.clusterSecurityGroupId,
      { mutable: true },
    );
    clusterSg.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(8080),
      'ALB to Keycloak HTTP',
    );
    clusterSg.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(9000),
      'ALB to Keycloak health/metrics',
    );
    // Keycloak JGroups (JDBC_PING discovery + cluster comms) between pods.
    clusterSg.addIngressRule(
      clusterSg,
      ec2.Port.tcp(7800),
      'Keycloak JGroups intra-cluster',
    );

    // ---- Allow EKS nodes -> Aurora 5432 ------------------------------------
    // Created here (not in the database stack) so the dependency stays
    // one-directional: eks -> database (matching the secret grants below).
    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromNodes', {
      groupId: dbSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.clusterSecurityGroupId,
      description: 'EKS cluster security group to Aurora PostgreSQL',
    });

    // ---- Keycloak workload (manifests live in this stack with the cluster) -
    const cd = config.cloudfront.customDomain;
    const publicUrl =
      cd.enabled && cd.domainName
        ? `https://${cd.domainName}`
        : config.keycloak.publicUrl && config.keycloak.publicUrl.length > 0
          ? config.keycloak.publicUrl
          : undefined;

    new KeycloakWorkload(this, 'Keycloak', {
      config,
      cluster: this.cluster,
      dbSecret,
      dbWriterEndpoint,
      targetGroupArn: this.targetGroup.targetGroupArn,
      publicUrl,
      crdDependencies: [csiDriver, awsProvider, this.cluster.albController].filter(
        (d): d is NonNullable<typeof d> => d !== undefined,
      ),
    });

    new CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name (CloudFront origin)',
    });
    new CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: 'Target group ARN for Keycloak TargetGroupBinding',
    });

    Tags.of(this).add('Component', 'eks');
  }
}
