/**
 * Configuration for the AWS ZHY (ZHY, cn-northwest-1) deployment.
 *
 * Architecture: ALB (public entry) -> EKS (Graviton) -> Aurora PostgreSQL (Graviton).
 * NO CloudFront (ZHY CloudFront needs ICP filing). The ALB is the public entry point.
 *
 * ZHY (aws-cn) specifics handled here / flagged for verification:
 *  - Partition arn:aws-cn:* is applied automatically by CDK when region is a cn region.
 *  - ALB Controller image MUST come from the ZHY regional ECR (CDK still defaults the
 *    repo to a us-west-2 account, which is unreachable from some networks) -> eks.albControllerRepository.
 *  - Graviton classes: m7g/r7g (Graviton3) verified available in cn-northwest-1 (EKS nodes + Aurora PG).
 *  - EKS version: ZHY regions lag global; verify supported versions and keep the
 *    kubectl layer (package.json @aws-cdk/lambda-layer-kubectl-vXX) matched to it.
 *  - HTTPS without CloudFront: put an ACM cert (cn-northwest-1) on the ALB. The domain
 *    must be ICP-filed (备案). Without a domain, the ALB serves HTTP only (testing).
 *  - Keycloak image: pull from quay.io is slow/unreliable from ZHY; push to ECR
 *    cn-northwest-1 and set keycloak.image to that ECR URI.
 *  - SAML federation endpoint is signin.amazonaws.cn/saml (configured later in Keycloak).
 */

export interface KeycloakHaConfig {
  readonly account?: string;
  readonly region: string;
  readonly project: string;
  readonly tags: { [key: string]: string };

  readonly vpc: {
    readonly cidr: string;
    readonly maxAzs: number;
    readonly natGateways: number;
  };

  readonly eks: {
    readonly clusterName: string;
    readonly version: string;
    readonly nodeInstanceTypes: string[];
    readonly nodeMinSize: number;
    readonly nodeDesiredSize: number;
    readonly nodeMaxSize: number;
    readonly nodeDiskSizeGiB: number;
    readonly publicEndpointAllowedCidrs: string[];
    readonly clusterAdminPrincipalArns: string[];
    /**
     * REQUIRED for ZHY: full ECR image repo for the AWS Load Balancer Controller,
     * e.g. "<acct>.dkr.ecr.cn-northwest-1.amazonaws.com.cn/amazon/aws-load-balancer-controller".
     * CDK otherwise defaults to a us-west-2 account that is unreachable from some networks.
     * VERIFY the account id against the AWS doc "Amazon container image registries".
     */
    readonly albControllerRepository: string;
  };

  readonly aurora: {
    readonly engineVersion: string;
    readonly instanceClass: string;
    readonly readers: number;
    readonly databaseName: string;
    readonly backupRetentionDays: number;
    readonly deletionProtection: boolean;
  };

  readonly keycloak: {
    readonly image: string;
    readonly namespace: string;
    /**
     * Public base URL set as KC_HOSTNAME, e.g. "https://idp.example.cn" (with ALB ACM
     * cert) or "http://<alb-dns-name>" for HTTP testing. Leave empty on first deploy,
     * then set from the ALB DNS / your domain and redeploy.
     */
    readonly publicUrl?: string;
    readonly replicas: number;
    readonly hpaMinReplicas: number;
    readonly hpaMaxReplicas: number;
    readonly hpaCpuTargetPercent: number;
    readonly cpuRequest: string;
    readonly cpuLimit: string;
    readonly memRequest: string;
    readonly memLimit: string;
  };

  /** ALB is the public entry point (replaces CloudFront in the ZHY variant). */
  readonly alb: {
    /** Source CIDRs allowed to reach the ALB. Default open (public IdP); restrict for internal. */
    readonly allowedCidrs: string[];
    /**
     * ACM certificate ARN in cn-northwest-1 for an HTTPS listener (443). When set, the
     * ALB terminates TLS and redirects 80 -> 443. The cert domain must be ICP-filed.
     * Leave empty to serve plain HTTP on 80 (testing only).
     */
    readonly certArn?: string;
    /** ICP-filed domain bound to the ALB (used for KC_HOSTNAME when certArn is set). */
    readonly domainName?: string;
  };
}

export const config: KeycloakHaConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'cn-northwest-1',

  project: 'keycloak-ha-cn',
  tags: {
    Project: 'keycloak-ha-cn',
    Environment: 'production',
    ManagedBy: 'cdk',
  },

  vpc: {
    cidr: '10.70.0.0/16',
    maxAzs: 3,
    natGateways: 3,
  },

  eks: {
    clusterName: 'keycloak-ha-cn',
    // Verified via `aws eks describe-cluster-versions --region cn-northwest-1 --profile china`:
    // cn-northwest-1 supports up to 1.36. Pinned to 1.35 to match the us-west-2 variant and
    // the available kubectl layer (no @aws-cdk/lambda-layer-kubectl-v36 package exists yet).
    // Keep this in sync with the @aws-cdk/lambda-layer-kubectl-vXX package in package.json.
    version: '1.35',
    nodeInstanceTypes: ['m7g.large'], // Graviton3 - verified available in cn-northwest-1 (matches us-west-2)
    nodeMinSize: 3,
    nodeDesiredSize: 3,
    nodeMaxSize: 6,
    nodeDiskSizeGiB: 30,
    publicEndpointAllowedCidrs: [], // recommend restricting to your egress CIDRs
    clusterAdminPrincipalArns: [], // set to your IAM user/role ARN (arn:aws-cn:iam::...) before deploy
    // VERIFY the account id for cn-northwest-1 against the official registry doc.
    albControllerRepository:
      '961992271922.dkr.ecr.cn-northwest-1.amazonaws.com.cn/amazon/aws-load-balancer-controller',
  },

  aurora: {
    engineVersion: '16.4',
    instanceClass: 'r7g.large', // Graviton3 - verified orderable for Aurora PG in cn-northwest-1 (matches us-west-2)
    readers: 1,
    databaseName: 'keycloak',
    backupRetentionDays: 14,
    deletionProtection: true,
  },

  keycloak: {
    // ZHY: mirrored from quay.io to this account's cn-northwest-1 ECR (quay.io is
    // unreliable/unreachable from some networks). Stored as repo:tag only; the full ECR registry
    // (<account>.dkr.ecr.<region>.amazonaws.com.cn) is prepended at deploy time so no
    // account id is hard-coded in source.
    image: 'keycloak:26.1.4',
    namespace: 'keycloak',
    publicUrl: '', // set to https://<icp-domain> or http://<alb-dns> after first deploy
    replicas: 2,
    hpaMinReplicas: 2,
    hpaMaxReplicas: 6,
    hpaCpuTargetPercent: 70,
    cpuRequest: '500m',
    cpuLimit: '2000m',
    memRequest: '1Gi',
    memLimit: '2Gi',
  },

  alb: {
    allowedCidrs: [], // LOCKED DOWN on deploy (no ingress). Add the VPN prefix list rule to the ALB SG manually after deploy.
    // certArn: 'arn:aws-cn:acm:cn-northwest-1:<acct>:certificate/...',
    // domainName: 'idp.example.cn',
  },
};
