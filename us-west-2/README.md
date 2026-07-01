# Keycloak HA on AWS (CDK) — Amazon Quick / QuickSight SSO

Production-grade, highly available Keycloak Identity Provider on AWS, deployed with
AWS CDK (TypeScript). Fully ARM/Graviton. Region: **us-west-2 (Oregon)**.

This is the HA redesign of the single-EC2 demo
(`amazon-quick-desktop-federation-with-keycloak`): the ephemeral H2 database is
replaced by Aurora PostgreSQL, the single instance by a multi-AZ EKS cluster, and the
`nip.io` + Let's Encrypt entrypoint by CloudFront + ALB with managed certificates.

## Architecture

```
 user (HTTPS)
   │
 CloudFront            REDIRECT_TO_HTTPS, CachingDisabled, AllViewer
   │  (HTTP origin, locked to CloudFront prefix list)
 ALB (multi-AZ)        internet-facing, SG = CloudFront origin-facing prefix list only
   │  (HTTP 8080, private)
 EKS pods (Keycloak)   Graviton nodes (AL2023 arm64), 2+ replicas, JDBC_PING cluster
   │  (5432, isolated)
 Aurora PostgreSQL     Graviton r7g, Writer + Reader, Multi-AZ, encrypted
```

**TLS model (no custom domain yet):**
| Segment | Encryption | Control |
|---------|-----------|---------|
| user → CloudFront | HTTPS (CloudFront default cert) | only HTTPS exposed publicly |
| CloudFront → ALB | HTTP (AWS backbone) | ALB SG allows **only** the CloudFront origin-facing prefix list |
| ALB → Pod | HTTP 8080 (private subnets) | SG locked to ALB SG |

To upgrade to **end-to-end HTTPS**, set `cloudfront.customDomain.enabled = true` in
`lib/config.ts` and provide a domain + ACM certs (see below). No refactor needed.

## Stacks

| Stack | Contents |
|-------|----------|
| `keycloak-ha-network` | VPC (3 AZ), public/private/isolated subnets, NAT, VPC endpoints |
| `keycloak-ha-database` | Aurora PostgreSQL 16 (Graviton), Writer+Reader, Secrets Manager, SG |
| `keycloak-ha-eks` | EKS cluster, ARM managed node group, ALB Controller, Secrets Store CSI, ALB + target group, **and the Keycloak workload** (Deployment/Service/HPA/PDB/TargetGroupBinding + SecretProviderClass + admin secret) |
| `keycloak-ha-cloudfront` | CloudFront distribution fronting the ALB |

## Prerequisites

- Node.js 18+, AWS CLI v2, `kubectl`, Docker (for CDK asset bundling).
- AWS credentials for the target account; CDK bootstrapped in us-west-2:
  ```bash
  npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2
  ```
- Edit `lib/config.ts`:
  - `eks.clusterAdminPrincipalArns`: IAM principal ARN(s) to grant cluster-admin — the
    role or user you run `kubectl` as. **Required**: if left empty, no human can `kubectl`
    into the cluster after deploy (the CDK still deploys the workload, but you cannot
    operate it manually). Both Role ARNs (`arn:aws:iam::<acct>:role/...`) and User ARNs
    (`arn:aws:iam::<acct>:user/...`) are accepted.
  - `eks.publicEndpointAllowedCidrs`: lock the EKS public API endpoint to your egress
    CIDRs. Empty = open public endpoint (NOT recommended for production).

## Customer pre-deployment checklist

Run through this before `cdk deploy` in a fresh customer account:

- [ ] **Tooling**: Node.js 18+, AWS CLI v2, `kubectl`, Docker running (CDK bundles assets in Docker).
- [ ] **Credentials**: AWS credentials point at the customer's target account — verify with
      `aws sts get-caller-identity`.
- [ ] **Bootstrap**: `npx cdk bootstrap aws://<CUSTOMER_ACCOUNT_ID>/us-west-2`.
- [ ] **No stale context**: `cdk.context.json` and `cdk.out/` are absent (they cache the
      previous account's AZs/assets and regenerate on synth; both are gitignored).
- [ ] **`lib/config.ts` filled in**:
  - [ ] `eks.clusterAdminPrincipalArns` = customer's admin Role/User ARN (else no kubectl access).
  - [ ] `eks.publicEndpointAllowedCidrs` = customer's office/VPN egress CIDRs (else EKS API is public).
  - [ ] `keycloak.publicUrl` = empty for the first deploy (pinned on the second pass — see Deploy).
  - [ ] (optional) Aurora / EKS node sizes / Keycloak replicas tuned for the customer's load.
- [ ] **Region & quotas**: target is us-west-2; confirm EKS, Aurora, NAT/EIP quota headroom.
- [ ] **Image reachability**: `quay.io/keycloak/keycloak` pullable via the account's NAT egress
      (fine in us-west-2; for AWS ZHY see the ZHY notes below).

## Deploy

```bash
npm install
npm run build          # tsc type-check
npx cdk synth          # render CloudFormation
npx cdk deploy --all   # ~25-35 min (EKS + Aurora are the slow parts)
```

Stacks deploy in dependency order: network → database → eks → cloudfront.

**Two-pass first deploy (pin KC_HOSTNAME):** leave `keycloak.publicUrl` empty in
`lib/config.ts` for the very first `cdk deploy --all`. After it completes, copy the
`keycloak-ha-cloudfront.KeycloakPublicUrl` output into `keycloak.publicUrl` and run
`npx cdk deploy keycloak-ha-eks` again so Keycloak emits correct `https://` URLs.
(With `cloudfront.customDomain.enabled = true`, the custom domain is used automatically
and this step is unnecessary.)

After deploy, read the outputs:
- `keycloak-ha-cloudfront.KeycloakPublicUrl` → your Keycloak base URL (e.g. `https://dxxxx.cloudfront.net`).
- `keycloak-ha-eks` provisions the admin password into Secrets Manager
  (`keycloak-ha/keycloak/admin`). Retrieve it:
  ```bash
  aws secretsmanager get-secret-value --secret-id keycloak-ha/keycloak/admin \
    --region us-west-2 --query SecretString --output text
  ```

Connect `kubectl`:
```bash
aws eks update-kubeconfig --name keycloak-ha --region us-west-2
kubectl -n keycloak get pods,svc,hpa,targetgroupbinding
```

## Post-deploy: Keycloak realm + Amazon Quick (QuickSight) federation

The infra deploys Keycloak itself; realm/client/federation config is a one-time setup
(can be automated later via a Job or Teralist/keycloak-config-cli). Outline:

1. **Admin console**: `https://<public-domain>/admin/` — log in as `admin`.
2. **Create realm** `aws-realm` (sslRequired=external, bruteForceProtected=true).
3. **OIDC client** for Quick Desktop: `amazon-quick-desktop`, public client, PKCE S256,
   redirect URIs `http://localhost:*`, `http://127.0.0.1:*`, `quick://callback`.
4. **SAML client** for Quick Web: `urn:amazon:webservices`, ACS
   `https://signin.aws.amazon.com/saml`, with the AWS Role / RoleSessionName /
   SessionDuration attribute mappers.
5. **IAM**: create a SAML Provider from the realm's SAML descriptor and a federation
   role trusting it (scope `quicksight:*` down to least privilege for production).

> See **[`USAGE-GUIDE.md`](./USAGE-GUIDE.md)** for the exact realm/client/mapper steps and
> the IAM SAML provider + federation role setup, with endpoints pointed at the CloudFront URL.

## Upgrade to end-to-end HTTPS (custom domain)

1. Request ACM certs: one in **us-east-1** (CloudFront viewer cert) and one in
   **us-west-2** (ALB listener cert) for your domain.
2. In `lib/config.ts` set:
   ```ts
   cloudfront: {
     customDomain: {
       enabled: true,
       domainName: 'idp.example.com',
       viewerCertArnUsEast1: 'arn:aws:acm:us-east-1:...:certificate/...',
       albCertArnUsWest2: 'arn:aws:acm:us-west-2:...:certificate/...',
     },
   },
   ```
3. `cdk deploy --all`, then point your DNS (CNAME `idp.example.com` → CloudFront domain).
   Origin becomes HTTPS; `KC_HOSTNAME` becomes `https://idp.example.com`.

## ZHY (cn-northwest-1) adaptation notes

This project targets us-west-2. For AWS ZHY (ZHY), the following must change —
do **not** deploy as-is:

- **Partition**: all ARNs become `arn:aws-cn:...` — use `${AWS::Partition}` / CDK
  partition tokens (CDK handles most automatically when `region` is a cn region).
- **SAML endpoints**: AWS sign-in is `signin.amazonaws.cn/saml` (not `.com`); update the
  SAML client audience/ACS and QuickSight RelayState to the ZHY console URL.
- **Route 53**: not offered in ZHY — manage DNS at your registrar / a ZHY DNS provider.
- **CloudFront**: requires **ICP filing (备案)** for any served domain; the
  "free HTTPS via default domain" trick does not apply. For testing, use **ALB + ACM**
  on an ICP-filed subdomain; add CloudFront for production.
- **Container image**: `quay.io` pulls are slow/unreliable in ZHY — push the Keycloak
  image to **ECR in cn-northwest-1** and reference it in `config.keycloak.image`.
- **QuickSight / Amazon Quick**: verify regional availability and exact SAML endpoints in
  the ZHY console before building the federation.

## Cleanup

```bash
npx cdk destroy --all
```
Aurora has `deletionProtection: true` and the admin/DB secrets use `RETAIN` — delete
those manually if you intend a full teardown.

## Security notes

- ALB is internet-facing but its SG only admits the CloudFront origin-facing prefix list.
- EKS API public endpoint should be restricted via `eks.publicEndpointAllowedCidrs`.
- DB and admin credentials live in Secrets Manager, injected via Secrets Store CSI (IRSA);
  no plaintext secrets in manifests.
- Aurora enforces TLS (`rds.force_ssl=1`), is encrypted at rest, and is in isolated subnets.
- WAF is intentionally omitted for now; add an `AWS::WAFv2::WebACL` association to the
  CloudFront distribution when ready.
