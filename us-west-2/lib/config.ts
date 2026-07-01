/**
 * Central configuration for the Keycloak HA deployment.
 *
 * Everything tunable lives here so the stacks stay declarative.
 * Region is fixed to us-west-2 (Oregon). All compute/database is ARM/Graviton.
 *
 * TLS model (no custom domain yet):
 *   user -> CloudFront : HTTPS (CloudFront default *.cloudfront.net cert)
 *   CloudFront -> ALB  : HTTP, but ALB SG only allows the CloudFront origin-facing
 *                        managed prefix list, so nothing else can reach the ALB.
 *   ALB -> Pod         : HTTP 8080 inside private subnets.
 *
 * To upgrade to end-to-end HTTPS later, set customDomain.enabled = true and provide
 * a domain name + an ACM certificate ARN (in us-west-2) for the ALB. No refactor needed.
 */

export interface KeycloakHaConfig {
  /** AWS account id; falls back to CDK_DEFAULT_ACCOUNT at synth time when empty. */
  readonly account?: string;
  readonly region: string;

  readonly project: string;
  readonly tags: { [key: string]: string };

  readonly vpc: {
    readonly cidr: string;
    readonly maxAzs: number;
    /** One NAT gateway per AZ for production HA. Lower to 1 to cut cost in dev. */
    readonly natGateways: number;
  };

  readonly eks: {
    readonly clusterName: string;
    readonly version: string; // Kubernetes version, e.g. "1.30"
    /** Graviton instance types for the managed node group. */
    readonly nodeInstanceTypes: string[];
    readonly nodeMinSize: number;
    readonly nodeDesiredSize: number;
    readonly nodeMaxSize: number;
    readonly nodeDiskSizeGiB: number;
    /**
     * Restrict EKS public API endpoint access to these CIDRs (your office/VPN egress).
     * Empty array = open public endpoint (NOT recommended for production).
     */
    readonly publicEndpointAllowedCidrs: string[];
    /** Principal ARNs (roles/users) to grant cluster-admin via EKS access entries. */
    readonly clusterAdminPrincipalArns: string[];
  };

  readonly aurora: {
    /** Aurora PostgreSQL engine version. */
    readonly engineVersion: string;
    /** Graviton instance class, e.g. "r7g.large". */
    readonly instanceClass: string;
    /** Number of reader instances (in addition to the writer). */
    readonly readers: number;
    readonly databaseName: string;
    readonly backupRetentionDays: number;
    readonly deletionProtection: boolean;
  };

  readonly keycloak: {
    /** Multi-arch image; arm64 manifest is pulled automatically on Graviton nodes. */
    readonly image: string;
    readonly namespace: string;
    /**
     * Public base URL set as KC_HOSTNAME (e.g. "https://dxxxx.cloudfront.net").
     * Leave empty on the first deploy; after CloudFront is created, copy the
     * KeycloakPublicUrl output here and redeploy so Keycloak emits correct https
     * URLs. When cloudfront.customDomain.enabled=true, the custom domain is used
     * automatically and this can stay empty.
     */
    readonly publicUrl?: string;
    readonly replicas: number;
    readonly hpaMinReplicas: number;
    readonly hpaMaxReplicas: number;
    readonly hpaCpuTargetPercent: number;
    /** Kubernetes resource requests/limits per pod. */
    readonly cpuRequest: string;
    readonly cpuLimit: string;
    readonly memRequest: string;
    readonly memLimit: string;
  };

  readonly cloudfront: {
    readonly customDomain: {
      readonly enabled: boolean;
      readonly domainName?: string;
      /** ACM cert ARN in us-east-1 for CloudFront viewer cert (when enabled). */
      readonly viewerCertArnUsEast1?: string;
      /** ACM cert ARN in us-west-2 for the ALB listener (enables HTTPS origin). */
      readonly albCertArnUsWest2?: string;
    };
  };
}

export const config: KeycloakHaConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-west-2',

  project: 'keycloak-ha',
  tags: {
    Project: 'keycloak-ha',
    Environment: 'production',
    ManagedBy: 'cdk',
    Application: 'amazon-quick-sso',
  },

  vpc: {
    cidr: '10.60.0.0/16',
    maxAzs: 3,
    natGateways: 3,
  },

  eks: {
    clusterName: 'keycloak-ha',
    version: '1.35', // stepwise upgrade 1.30 -> 1.36 (EKS allows only one minor at a time); live cluster on 1.35 (standard support)
    nodeInstanceTypes: ['m7g.large'], // Graviton3
    nodeMinSize: 3,
    nodeDesiredSize: 3,
    nodeMaxSize: 6,
    nodeDiskSizeGiB: 30,
    // IMPORTANT: replace with your admin CIDR(s). Empty = fully open public endpoint.
    publicEndpointAllowedCidrs: [],
    // IMPORTANT: replace with the IAM role/user ARN you run `kubectl` as.
    clusterAdminPrincipalArns: [],
  },

  aurora: {
    engineVersion: '18.3',
    instanceClass: 'r7g.large', // Graviton3
    readers: 1,
    databaseName: 'keycloak',
    backupRetentionDays: 14,
    deletionProtection: true,
  },

  keycloak: {
    image: 'quay.io/keycloak/keycloak:26.6.4',
    namespace: 'keycloak',
    publicUrl: '', // First deploy: leave empty. After CloudFront exists, paste the keycloak-ha-cloudfront.KeycloakPublicUrl output here and redeploy keycloak-ha-eks to pin the https KC_HOSTNAME.
    replicas: 2,
    hpaMinReplicas: 2,
    hpaMaxReplicas: 6,
    hpaCpuTargetPercent: 70,
    cpuRequest: '500m',
    cpuLimit: '2000m',
    memRequest: '1Gi',
    memLimit: '2Gi',
  },

  cloudfront: {
    customDomain: {
      enabled: false,
      // domainName: 'idp.example.com',
      // viewerCertArnUsEast1: 'arn:aws:acm:us-east-1:...:certificate/...',
      // albCertArnUsWest2: 'arn:aws:acm:us-west-2:...:certificate/...',
    },
  },
};
