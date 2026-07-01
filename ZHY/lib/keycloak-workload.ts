import { Tags, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct, IDependable } from 'constructs';
import { KeycloakHaConfig } from './config';

/**
 * KeycloakWorkload applies all Keycloak Kubernetes resources to the cluster.
 *
 * Implemented as a Construct (not a Stack) and instantiated inside EksStack so its
 * manifests live in the same stack as the cluster - avoiding cross-stack cycles with
 * CloudFront. KC_HOSTNAME comes from config (not a CloudFront token).
 *
 * HA features: arm64 nodeSelector, zone-spread anti-affinity, Infinispan + JGroups
 * JDBC_PING clustering (discovery via Aurora), HPA, PDB, Secrets Store CSI injection.
 */
export interface KeycloakWorkloadProps {
  readonly config: KeycloakHaConfig;
  readonly cluster: eks.ICluster;
  readonly dbSecret: secretsmanager.ISecret;
  readonly dbWriterEndpoint: string;
  readonly targetGroupArn: string;
  /** Public base URL for KC_HOSTNAME; when empty, KC_HOSTNAME_STRICT is disabled. */
  readonly publicUrl?: string;
  /**
   * Constructs that install required CRDs / drivers (Secrets Store CSI driver,
   * AWS provider, ALB controller). Keycloak manifests depend on these so they are
   * not applied before the CRDs exist.
   */
  readonly crdDependencies?: IDependable[];
}

export class KeycloakWorkload extends Construct {
  public readonly adminSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: KeycloakWorkloadProps) {
    super(scope, id);
    const { config, cluster, dbSecret, dbWriterEndpoint, targetGroupArn, publicUrl } = props;
    const ns = config.keycloak.namespace;
    const appLabels = { app: 'keycloak' };
    const crdDeps = props.crdDependencies ?? [];

    // ---- Admin bootstrap credential (Secrets Manager) ----------------------
    const adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: `${config.project}/keycloak/admin`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.adminSecret = adminSecret;

    // ---- Namespace ---------------------------------------------------------
    const namespace = cluster.addManifest('KeycloakNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: ns, labels: { 'app.kubernetes.io/part-of': 'keycloak-ha' } },
    });

    // ---- IRSA service account (read secrets via CSI provider) --------------
    const sa = cluster.addServiceAccount('KeycloakSa', { name: 'keycloak', namespace: ns });
    sa.node.addDependency(namespace);
    dbSecret.grantRead(sa.role);
    adminSecret.grantRead(sa.role);

    // ---- Credentials via IRSA init container (CHINA) -----------------------
    // The Secrets Store CSI Driver is blocked in China (GitHub-hosted Helm charts),
    // and CloudFormation dynamic references are NOT resolved inside eks addManifest
    // custom resources. So an init container (aws-cli, mirrored to the China ECR)
    // uses the pod's IRSA role to fetch the DB/admin credentials from Secrets Manager
    // at startup and writes them to a shared in-memory volume. The Keycloak container
    // then exports them before launching. Credentials never touch etcd or the template.
    const auroraSecretName = `${config.project}/aurora/credentials`;
    const adminSecretName = `${config.project}/keycloak/admin`;
    // ECR registry for this account/region, derived from CDK tokens so no account id
    // is hard-coded in source (resolves to the real registry at deploy time).
    const ecrRegistry = `${Stack.of(this).account}.dkr.ecr.${config.region}.amazonaws.com.cn`;
    const credsInitImage = `${ecrRegistry}/aws-cli:latest`;
    const fetchCredsScript = [
      'set -e',
      // IRSA token exchange must use the regional STS endpoint in China (aws-cn).
      `export AWS_REGION=${config.region} AWS_DEFAULT_REGION=${config.region} AWS_STS_REGIONAL_ENDPOINTS=regional`,
      `DB=$(aws secretsmanager get-secret-value --secret-id ${auroraSecretName} --query SecretString --output text)`,
      `AD=$(aws secretsmanager get-secret-value --secret-id ${adminSecretName} --query SecretString --output text)`,
      `printf '%s' "$DB" | sed -n 's/.*"username":"\\([^"]*\\)".*/\\1/p' > /creds/db_user`,
      `printf '%s' "$DB" | sed -n 's/.*"password":"\\([^"]*\\)".*/\\1/p' > /creds/db_pass`,
      `printf '%s' "$AD" | sed -n 's/.*"password":"\\([^"]*\\)".*/\\1/p' > /creds/admin_pass`,
    ].join('; ');
    const keycloakStartScript = [
      'export KC_DB_USERNAME="$(cat /creds/db_user)"',
      'export KC_DB_PASSWORD="$(cat /creds/db_pass)"',
      'export KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat /creds/admin_pass)"',
      'exec /opt/keycloak/bin/kc.sh start',
    ].join('; ');

    // ---- Environment (hostname handling) -----------------------------------
    const env: Array<{ name: string; value?: string; valueFrom?: object }> = [
      { name: 'KC_DB', value: 'postgres' },
      {
        name: 'KC_DB_URL',
        value: `jdbc:postgresql://${dbWriterEndpoint}:5432/${config.aurora.databaseName}`,
      },
      { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
      { name: 'KC_HTTP_ENABLED', value: 'true' },
      { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
      { name: 'KC_HEALTH_ENABLED', value: 'true' },
      { name: 'KC_METRICS_ENABLED', value: 'true' },
      { name: 'KC_CACHE', value: 'ispn' },
      { name: 'KC_CACHE_STACK', value: 'jdbc-ping' },
      { name: 'JAVA_OPTS_APPEND', value: '-XX:MaxRAMPercentage=70' },
    ];
    if (publicUrl && publicUrl.length > 0) {
      // Pin the external https URL so Keycloak emits correct frontend/issuer URLs.
      env.push({ name: 'KC_HOSTNAME', value: publicUrl });
      env.push({ name: 'KC_HOSTNAME_STRICT', value: 'true' });
    } else {
      // First-deploy / no public URL yet: derive hostname from forwarded headers.
      env.push({ name: 'KC_HOSTNAME_STRICT', value: 'false' });
    }

    // ---- Deployment --------------------------------------------------------
    const deployment = cluster.addManifest('KeycloakDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'keycloak', namespace: ns, labels: appLabels },
      spec: {
        replicas: config.keycloak.replicas,
        selector: { matchLabels: appLabels },
        template: {
          metadata: { labels: appLabels },
          spec: {
            serviceAccountName: 'keycloak',
            nodeSelector: { 'kubernetes.io/arch': 'arm64' },
            initContainers: [
              {
                name: 'fetch-credentials',
                image: credsInitImage,
                command: ['/bin/sh', '-c'],
                args: [fetchCredsScript],
                volumeMounts: [{ name: 'creds', mountPath: '/creds' }],
              },
            ],
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    podAffinityTerm: {
                      labelSelector: { matchLabels: appLabels },
                      topologyKey: 'topology.kubernetes.io/zone',
                    },
                  },
                  {
                    weight: 50,
                    podAffinityTerm: {
                      labelSelector: { matchLabels: appLabels },
                      topologyKey: 'kubernetes.io/hostname',
                    },
                  },
                ],
              },
            },
            containers: [
              {
                name: 'keycloak',
                image: `${ecrRegistry}/${config.keycloak.image}`,
                command: ['/bin/sh', '-c'],
                args: [keycloakStartScript],
                ports: [
                  { name: 'http', containerPort: 8080 },
                  { name: 'management', containerPort: 9000 },
                  { name: 'jgroups', containerPort: 7800 },
                ],
                env,
                volumeMounts: [{ name: 'creds', mountPath: '/creds', readOnly: true }],
                resources: {
                  requests: {
                    cpu: config.keycloak.cpuRequest,
                    memory: config.keycloak.memRequest,
                  },
                  limits: {
                    cpu: config.keycloak.cpuLimit,
                    memory: config.keycloak.memLimit,
                  },
                },
                startupProbe: {
                  httpGet: { path: '/health/started', port: 9000 },
                  failureThreshold: 30,
                  periodSeconds: 5,
                },
                readinessProbe: {
                  httpGet: { path: '/health/ready', port: 9000 },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/health/live', port: 9000 },
                  periodSeconds: 15,
                },
              },
            ],
            volumes: [{ name: 'creds', emptyDir: { medium: 'Memory' } }],
          },
        },
      },
    });
    deployment.node.addDependency(sa);
    for (const d of crdDeps) deployment.node.addDependency(d);

    // ---- Service -----------------------------------------------------------
    const service = cluster.addManifest('KeycloakService', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'keycloak', namespace: ns, labels: appLabels },
      spec: {
        type: 'ClusterIP',
        selector: appLabels,
        ports: [
          { name: 'http', port: 8080, targetPort: 8080, protocol: 'TCP' },
          { name: 'management', port: 9000, targetPort: 9000, protocol: 'TCP' },
        ],
      },
    });
    service.node.addDependency(namespace);

    // ---- TargetGroupBinding (register pods into the CDK ALB target group) --
    const tgb = cluster.addManifest('KeycloakTgb', {
      apiVersion: 'elbv2.k8s.aws/v1beta1',
      kind: 'TargetGroupBinding',
      metadata: { name: 'keycloak', namespace: ns },
      spec: {
        targetGroupARN: targetGroupArn,
        targetType: 'ip',
        serviceRef: { name: 'keycloak', port: 8080 },
      },
    });
    tgb.node.addDependency(service);
    for (const d of crdDeps) tgb.node.addDependency(d);

    // ---- HPA ---------------------------------------------------------------
    const hpa = cluster.addManifest('KeycloakHpa', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'keycloak', namespace: ns },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'keycloak' },
        minReplicas: config.keycloak.hpaMinReplicas,
        maxReplicas: config.keycloak.hpaMaxReplicas,
        metrics: [
          {
            type: 'Resource',
            resource: {
              name: 'cpu',
              target: {
                type: 'Utilization',
                averageUtilization: config.keycloak.hpaCpuTargetPercent,
              },
            },
          },
        ],
      },
    });
    hpa.node.addDependency(deployment);

    // ---- PodDisruptionBudget ----------------------------------------------
    const pdb = cluster.addManifest('KeycloakPdb', {
      apiVersion: 'policy/v1',
      kind: 'PodDisruptionBudget',
      metadata: { name: 'keycloak', namespace: ns },
      spec: { minAvailable: 1, selector: { matchLabels: appLabels } },
    });
    pdb.node.addDependency(deployment);

    Tags.of(this).add('Component', 'keycloak');
  }
}
