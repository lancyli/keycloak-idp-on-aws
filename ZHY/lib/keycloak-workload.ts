import { Tags, RemovalPolicy } from 'aws-cdk-lib';
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

    // ---- SecretProviderClass (sync SM secrets -> k8s Secret) ---------------
    const objectsYaml = [
      `- objectName: "${dbSecret.secretArn}"`,
      `  objectType: "secretsmanager"`,
      `  jmesPath:`,
      `    - path: "username"`,
      `      objectAlias: "db_username"`,
      `    - path: "password"`,
      `      objectAlias: "db_password"`,
      `- objectName: "${adminSecret.secretArn}"`,
      `  objectType: "secretsmanager"`,
      `  jmesPath:`,
      `    - path: "password"`,
      `      objectAlias: "admin_password"`,
    ].join('\n');

    const secretProviderClass = cluster.addManifest('KeycloakSpc', {
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: { name: 'keycloak-spc', namespace: ns },
      spec: {
        provider: 'aws',
        parameters: { objects: objectsYaml },
        secretObjects: [
          {
            secretName: 'keycloak-secrets',
            type: 'Opaque',
            data: [
              { objectName: 'db_username', key: 'KC_DB_USERNAME' },
              { objectName: 'db_password', key: 'KC_DB_PASSWORD' },
              { objectName: 'admin_password', key: 'KC_BOOTSTRAP_ADMIN_PASSWORD' },
            ],
          },
        ],
      },
    });
    secretProviderClass.node.addDependency(namespace);
    for (const d of crdDeps) secretProviderClass.node.addDependency(d);

    // ---- Environment (hostname handling) -----------------------------------
    const env: Array<{ name: string; value?: string; valueFrom?: object }> = [
      { name: 'KC_DB', value: 'postgres' },
      {
        name: 'KC_DB_URL',
        value: `jdbc:postgresql://${dbWriterEndpoint}:5432/${config.aurora.databaseName}`,
      },
      {
        name: 'KC_DB_USERNAME',
        valueFrom: { secretKeyRef: { name: 'keycloak-secrets', key: 'KC_DB_USERNAME' } },
      },
      {
        name: 'KC_DB_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'keycloak-secrets', key: 'KC_DB_PASSWORD' } },
      },
      { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
      {
        name: 'KC_BOOTSTRAP_ADMIN_PASSWORD',
        valueFrom: {
          secretKeyRef: { name: 'keycloak-secrets', key: 'KC_BOOTSTRAP_ADMIN_PASSWORD' },
        },
      },
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
                image: config.keycloak.image,
                args: ['start'],
                ports: [
                  { name: 'http', containerPort: 8080 },
                  { name: 'management', containerPort: 9000 },
                  { name: 'jgroups', containerPort: 7800 },
                ],
                env,
                volumeMounts: [
                  { name: 'secrets-store', mountPath: '/mnt/secrets-store', readOnly: true },
                ],
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
            volumes: [
              {
                name: 'secrets-store',
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'keycloak-spc' },
                },
              },
            ],
          },
        },
      },
    });
    deployment.node.addDependency(sa);
    deployment.node.addDependency(secretProviderClass);
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
