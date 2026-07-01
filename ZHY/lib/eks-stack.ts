import { Stack, StackProps, Duration, Tags, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as fs from 'fs';
import * as path from 'path';
import { KubectlV35Layer } from '@aws-cdk/lambda-layer-kubectl-v35';
import { Construct } from 'constructs';
import { KeycloakHaConfig } from './config';
import { KeycloakWorkload } from './keycloak-workload';

/**
 * EksStack (China / ZHY variant).
 *
 * EKS (Graviton) + a public-facing ALB that is the entry point (no CloudFront).
 * - ALB ingress is restricted to config.alb.allowedCidrs.
 * - If config.alb.certArn is set, the ALB terminates HTTPS (443) and redirects 80->443;
 *   otherwise it serves HTTP (80) only (testing).
 * - The AWS Load Balancer Controller image is pulled from the China regional ECR repo
 *   (config.eks.albControllerRepository), since CDK's default repo is unreachable in China.
 */
export interface EksStackProps extends StackProps {
  readonly config: KeycloakHaConfig;
  readonly vpc: ec2.IVpc;
  readonly dbSecret: secretsmanager.ISecret;
  readonly dbWriterEndpoint: string;
  readonly dbSecurityGroupId: string;
}

export class EksStack extends Stack {
  public readonly cluster: eks.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly clusterSecurityGroupId: string;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);
    const { config, vpc, dbSecret, dbWriterEndpoint, dbSecurityGroupId } = props;
    const hasCert = !!config.alb.certArn;

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
      defaultCapacity: 0,
      endpointAccess,
      // NOTE (China): the built-in `albController` option is intentionally NOT used
      // here because it fetches its Helm chart from https://aws.github.io/eks-charts
      // (GitHub Pages), which is blocked in China. The AWS Load Balancer Controller
      // is installed manually further below from a local chart asset (via S3).
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

    // Grant cluster-admin to operator principals. Accepts both IAM Role and IAM User
    // ARNs (China deployments commonly use arn:aws-cn:iam::...:user/...). Each entry
    // gets a unique, indexed construct id so multiple admins don't collide.
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

    // ---- EKS managed add-ons (consistent with the us-west-2 variant) --------
    // Register the core components as EKS-managed add-ons so they appear in the
    // console "Add-ons" tab and can be one-click upgraded / version-checked.
    // resolveConflicts=OVERWRITE lets them adopt the self-managed defaults that
    // EKS bootstraps with the cluster; addonVersion is omitted so EKS selects the
    // default compatible with the cluster's Kubernetes version.
    // CHINA: managed add-ons pull their images from the regional EKS ECR
    // (cn-northwest-1: 961992271922) automatically, so no custom repository is
    // needed here (unlike the ALB Controller above).
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

    // metrics-server: required for CPU-based HorizontalPodAutoscaler (HPA) to read
    // pod metrics. Without it the Keycloak HPA reports cpu:<unknown> and never scales.
    const metricsServerAddon = new eks.CfnAddon(this, 'MetricsServerAddon', {
      clusterName: this.cluster.clusterName,
      addonName: 'metrics-server',
      resolveConflicts: 'OVERWRITE',
    });
    metricsServerAddon.node.addDependency(nodeGroup);

    // ---- AWS Load Balancer Controller (CHINA: manual, no GitHub) -----------
    // Installs the same chart the built-in albController would, but from a LOCAL
    // asset (delivered via the CDK bootstrap S3 bucket, reachable in China) instead
    // of https://aws.github.io/eks-charts (blocked in China). The controller image
    // is pulled from the China regional EKS ECR. IRSA service account + IAM policy
    // replicate what the albController construct does, with the IAM policy resources
    // rewritten to the aws-cn partition.
    const albSa = this.cluster.addServiceAccount('AlbSa', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });
    const albPolicyJson = fs
      .readFileSync(path.join(__dirname, 'alb-iam-policy.json'), 'utf8')
      .replace(/arn:aws:/g, 'arn:aws-cn:');
    for (const stmt of JSON.parse(albPolicyJson).Statement) {
      albSa.addToPrincipalPolicy(iam.PolicyStatement.fromJson(stmt));
    }
    const albChartAsset = new s3assets.Asset(this, 'AlbChartAsset', {
      // Point at the EXTRACTED chart directory (not the .tgz): CDK zips the directory
      // and the kubectl helm handler extracts it. Passing a .tgz fails with
      // "File is not a zip file".
      path: path.join(__dirname, '..', 'charts', 'aws-load-balancer-controller'),
    });
    const albChart = this.cluster.addHelmChart('AlbController', {
      chartAsset: albChartAsset,
      release: 'aws-load-balancer-controller',
      namespace: 'kube-system',
      wait: true,
      values: {
        clusterName: this.cluster.clusterName,
        region: this.region,
        vpcId: vpc.vpcId,
        serviceAccount: { create: false, name: 'aws-load-balancer-controller' },
        image: {
          repository: config.eks.albControllerRepository,
          tag: 'v2.17.1',
        },
      },
    });
    albChart.node.addDependency(albSa);

    // NOTE (China): Secrets Store CSI Driver is intentionally NOT used here. Its Helm
    // charts come from GitHub (kubernetes-sigs.github.io / aws.github.io), which is
    // blocked in China. Keycloak's DB/admin credentials are instead injected via a
    // native Kubernetes Secret populated with CloudFormation dynamic references
    // (see keycloak-workload.ts) - no GitHub-hosted charts or images required.

    // ---- ALB security group (public entry, restricted to allowedCidrs) -----
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'ALB public entry - ingress restricted to config.alb.allowedCidrs',
    });
    for (const cidr of config.alb.allowedCidrs) {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        `User ${cidr} to ALB HTTP`,
      );
      if (hasCert) {
        this.albSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(443),
          `User ${cidr} to ALB HTTPS`,
        );
      }
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
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/ready',
        port: '9000',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
      stickinessCookieDuration: Duration.hours(1),
    });

    if (hasCert) {
      // HTTPS entry + HTTP->HTTPS redirect.
      this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        open: false,
        certificates: [elbv2.ListenerCertificate.fromArn(config.alb.certArn!)],
        defaultTargetGroups: [this.targetGroup],
      });
      this.alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      // HTTP only (testing - no ACM cert / ICP domain yet).
      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultTargetGroups: [this.targetGroup],
      });
    }

    // ---- Allow ALB -> pods + JGroups + Aurora ------------------------------
    this.clusterSecurityGroupId = this.cluster.clusterSecurityGroupId;
    const clusterSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ClusterSgRef',
      this.clusterSecurityGroupId,
      { mutable: true },
    );
    clusterSg.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8080), 'ALB to Keycloak HTTP');
    clusterSg.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(9000),
      'ALB to Keycloak health/metrics',
    );
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(7800), 'Keycloak JGroups intra-cluster');

    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromNodes', {
      groupId: dbSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.clusterSecurityGroupId,
      description: 'EKS cluster security group to Aurora PostgreSQL',
    });

    // ---- Public URL for KC_HOSTNAME ----------------------------------------
    const publicUrl =
      hasCert && config.alb.domainName
        ? `https://${config.alb.domainName}`
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
      crdDependencies: [albChart],
    });

    new CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name - public entry point (set KC_HOSTNAME / point your ICP domain here)',
    });
    new CfnOutput(this, 'KeycloakEntryHint', {
      value: hasCert
        ? `https://${config.alb.domainName ?? this.alb.loadBalancerDnsName}`
        : `http://${this.alb.loadBalancerDnsName}`,
      description: 'Keycloak base URL',
    });

    Tags.of(this).add('Component', 'eks');
  }
}
