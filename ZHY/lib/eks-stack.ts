import { Stack, StackProps, Duration, Tags, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
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
      kubectlLayer: new KubectlV32Layer(this, 'KubectlLayer'),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,
      endpointAccess,
      albController: {
        version: eks.AlbControllerVersion.V2_8_2,
        // CHINA: pull the controller image from the China regional ECR.
        repository: config.eks.albControllerRepository,
      },
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
      ],
    });

    // ---- ARM (Graviton) managed node group ---------------------------------
    this.cluster.addNodegroupCapacity('ArmNodeGroup', {
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

    // ---- Secrets Store CSI Driver + AWS provider ---------------------------
    // NOTE (China): these helm images pull from registry.k8s.io / public.ecr.aws,
    // which can be slow/blocked in China. Mirror them to ECR if pulls fail.
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
      crdDependencies: [csiDriver, awsProvider, this.cluster.albController].filter(
        (d): d is NonNullable<typeof d> => d !== undefined,
      ),
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
