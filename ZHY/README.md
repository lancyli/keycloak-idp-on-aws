# Keycloak HA on AWS ZHY (cn-northwest-1)

Independent CDK project. Architecture: **ALB (public entry) → EKS (Graviton) → Aurora
PostgreSQL (Graviton)**. **No CloudFront** (ZHY CloudFront requires ICP filing). All ARM.

This is the AWS ZHY (`aws-cn`) adaptation of the us-west-2 deployment in the parent
folder. Do not mix the two `node_modules` / `cdk.out`; deploy from this `ZHY/` folder.

## Architecture

```
 user (HTTPS via ALB ACM cert, or HTTP for testing)
   │
 ALB (multi-AZ, internet-facing)   SG restricted to alb.allowedCidrs; 80->443 redirect if cert
   │  (HTTP 8080, private)
 EKS pods (Keycloak)               Graviton nodes (AL2023 arm64), JDBC_PING cluster
   │  (5432, isolated)
 Aurora PostgreSQL                 Graviton, Writer + Reader, Multi-AZ, encrypted
```

## What differs from the us-west-2 version (ZHY specifics)

| Area | Adaptation |
|------|-----------|
| Partition | `arn:aws-cn:*` applied automatically by CDK when `region = cn-northwest-1`. |
| Public entry | **ALB** (not CloudFront). HTTPS needs an ACM cert (cn-northwest-1) on an **ICP-filed** domain (`alb.certArn` + `alb.domainName`); otherwise HTTP only (testing). |
| AWS LB Controller | The built-in `albController` is **not** used — its Helm chart is fetched from `aws.github.io/eks-charts` (unreachable from some networks). Instead it is installed from a **local chart asset** (`charts/aws-load-balancer-controller/`, delivered via CDK's S3, reachable from ZHY) + a manual IRSA ServiceAccount + IAM policy (`lib/alb-iam-policy.json`, resources rewritten to the `aws-cn` partition) + controller image from the ZHY EKS ECR (`eks.albControllerRepository`, default `961992271922`). |
| Graviton classes | `m7g.large` (nodes) and `r7g.large` (Aurora) — Graviton3, verified available in cn-northwest-1 (3 AZs) via the china profile; matches us-west-2. |
| EKS version | `1.35` (matches us-west-2). cn-northwest-1 already supports up to 1.36, but pinned to `1.35` to match the available `@aws-cdk/lambda-layer-kubectl-v35` (no v36 package yet). |
| EKS managed add-ons | `vpc-cni`, `kube-proxy`, `coredns`, `metrics-server` are installed as **EKS managed add-ons** (`resolveConflicts=OVERWRITE`) — visible in the console Add-ons tab and one-click upgradable; `metrics-server` powers CPU-based HPA. ZHY managed add-on images are pulled from the regional ECR (`961992271922`) automatically. |
| ALB Controller version | `v2.17.1` (chart `1.17.1`, matches us-west-2). |
| Secret injection | Secrets Store CSI Driver is **not** used (its Helm charts are GitHub-hosted, unreachable from some networks; and CFN dynamic references are not resolved inside eks manifests). DB/admin credentials are fetched at pod startup by an **IRSA init container** (aws-cli image) via `aws secretsmanager get-secret-value` (**using the regional STS endpoint**), written to an in-memory (tmpfs) volume, and `export`ed by the Keycloak container before launch. See "Database credentials" below. |
| Container image mirroring | Keycloak (`quay.io`) and the aws-cli init image (`public.ecr.aws`) are unreliable/unreachable from some networks — **mirror them to this account's cn-northwest-1 ECR**. `config.keycloak.image` holds only `repo:tag` (e.g. `keycloak:26.6.4`); the full ECR prefix (`<account>.dkr.ecr.<region>.amazonaws.com.cn`) is prepended at deploy time (no account id in source). |
| Route 53 | Not offered in ZHY — manage DNS at your registrar / ZHY DNS provider; point your ICP domain at the ALB. |
| SAML federation | AWS sign-in is `https://signin.amazonaws.cn/saml` (configured later inside Keycloak). |

## Prerequisites

- AWS ZHY account credentials for cn-northwest-1; CDK bootstrapped (see env vars under Deploy).
- **Image mirroring (required in ZHY)** — mirror two images to **this account's cn-northwest-1 ECR** from a host that can reach quay.io / public.ecr.aws:
  ```bash
  R=cn-northwest-1; ACCT=<CN_ACCOUNT_ID>
  ECR="$ACCT.dkr.ecr.cn-northwest-1.amazonaws.com.cn"
  aws ecr create-repository --repository-name keycloak --region $R --profile china || true
  aws ecr create-repository --repository-name aws-cli  --region $R --profile china || true
  aws ecr get-login-password --region $R --profile china | docker login --username AWS --password-stdin $ECR
  docker pull --platform linux/arm64 quay.io/keycloak/keycloak:26.6.4
  docker tag quay.io/keycloak/keycloak:26.6.4 $ECR/keycloak:26.6.4 && docker push $ECR/keycloak:26.6.4
  docker pull --platform linux/arm64 public.ecr.aws/aws-cli/aws-cli:latest
  docker tag public.ecr.aws/aws-cli/aws-cli:latest $ECR/aws-cli:latest && docker push $ECR/aws-cli:latest
  ```
  > The LB Controller **image** comes from the ZHY EKS ECR (`961992271922`) automatically — no mirroring needed.
- **Download the LB Controller chart locally (required in ZHY; `charts/` is git-ignored)** — the chart is not committed; before deploy, pull + extract it into `charts/` on a host that can reach `aws.github.io` (CDK packages it as an S3 asset, reachable from ZHY):
  ```bash
  mkdir -p charts
  helm pull aws-load-balancer-controller --repo https://aws.github.io/eks-charts --version 1.17.1 -d charts/
  tar xzf charts/aws-load-balancer-controller-1.17.1.tgz -C charts/
  # produces charts/aws-load-balancer-controller/ (the eks-stack.ts Asset points here)
  ```
- Edit `lib/config.ts`:
  - `eks.clusterAdminPrincipalArns` — **required**: your `arn:aws-cn:iam::...` admin
    principal(s) (User or Role ARN). If empty, no human can `kubectl`/manage the cluster.
  - `eks.publicEndpointAllowedCidrs` — restrict the EKS public API endpoint to your egress CIDRs.
  - `eks.albControllerRepository` — ZHY EKS ECR (ZHY default `961992271922`; Beijing `918309763551`).
  - `keycloak.image` — **`repo:tag` only** (default `keycloak:26.6.4`); the ECR prefix is prepended
    from the account/region at deploy — do **not** hard-code the full account URI.
  - `alb.allowedCidrs` — source CIDR(s) allowed to reach the ALB (default `[]` = locked, nobody in).
  - `alb.certArn` / `alb.domainName` — for HTTPS (needs an ICP-filed domain + cn-northwest-1 ACM cert).

## Customer pre-deployment checklist (AWS ZHY)

Run through this before `cdk deploy` in a fresh AWS ZHY account. Items marked **VERIFY**
cannot be assumed from outside ZHY — confirm them in the cn-northwest-1 console/CLI first.

- [ ] **Tooling**: Node.js 18+, AWS CLI v2, `kubectl`, Docker running (CDK bundles assets in Docker).
- [ ] **Credentials**: point at the customer's **AWS ZHY** account (`aws sts get-caller-identity`
      should return an `arn:aws-cn:...` identity).
- [ ] **Bootstrap**: `npx cdk bootstrap aws://<CN_ACCOUNT_ID>/cn-northwest-1`.
- [ ] **No stale context**: `cdk.context.json` and `cdk.out/` are absent (gitignored; regenerate on synth).
- [ ] **`lib/config.ts` filled in**:
  - [ ] `eks.clusterAdminPrincipalArns` = customer's `arn:aws-cn:iam::...` admin User/Role (else no kubectl access).
  - [ ] `eks.publicEndpointAllowedCidrs` = customer egress CIDRs (else EKS API is public).
  - [ ] `eks.albControllerRepository` = correct cn ECR (ZHY default `961992271922`; Beijing `918309763551`). **VERIFY**.
  - [ ] `keycloak.image` = **`repo:tag`** (default `keycloak:26.6.4`, not a full account URI). **VERIFY** mirrored to this account's ECR (see Prerequisites).
  - [ ] Keycloak `keycloak:26.6.4` and aws-cli init `aws-cli:latest` images both pushed (arm64) to this account's cn-northwest-1 ECR.
  - [ ] `alb.allowedCidrs` = your egress CIDR(s) (default `[]` = locked, nobody can reach it); for HTTPS set `alb.certArn` + `alb.domainName` (ICP-filed).
  - [ ] `keycloak.publicUrl` = empty for first deploy (pinned on the second pass — see below).
- [ ] LB Controller chart downloaded/extracted to `charts/aws-load-balancer-controller/` (see Prerequisites; `charts/` is git-ignored); its image tag `v2.17.1` exists in the ZHY EKS ECR (`961992271922`).
- [ ] EKS version `1.35` (verified via china profile that cn-northwest-1 offers 1.30–**1.36**;
      pinned to 1.35 to match `@aws-cdk/lambda-layer-kubectl-v35`).
- [ ] Aurora PostgreSQL `18.3` + `r7g.large` and node `m7g.large` — verified available in cn-northwest-1 (all 3 AZs) via the china profile.
- [ ] **VERIFY** EKS, Aurora, NAT/EIP quota headroom in the account.

## Deploy

> **One-command script**: the prep (image mirroring, chart pull) and the deploy can all be run
> with `deploy-china.sh` — `AWS_PROFILE=<your-china-profile> ./deploy-china.sh all` (the account
> id is auto-detected). Sub-commands: `prep` (mirror + chart only), `deploy` (build + deploy only),
> `clean-secret` (remove the retained admin secret before a retry), and `pin-hostname` (optional:
> pin `KC_HOSTNAME` — `PUBLIC_URL=https://<your-icp-domain> ./deploy-china.sh pin-hostname`, or omit
> `PUBLIC_URL` to use `http://<alb-dns>`; not needed for HTTP testing, useful once you serve HTTPS.
> Note: it redeploys the eks stack and reconciles the ALB SG to `alb.allowedCidrs` — set your egress
> CIDR there first so hand-added rules are not dropped). The manual equivalent below is
> for understanding / troubleshooting.

**ZHY-critical**: the `cdk` CLI resolves the account and calls STS. By default it uses the
**global STS endpoint**, which rejects `aws-cn` tokens ("Unable to resolve AWS account" /
"no credentials"). You must use the `AWS_PROFILE` env var + the **regional STS endpoint** +
an explicit account/region:

```bash
npm install
npm run build

export AWS_PROFILE=china
export AWS_REGION=cn-northwest-1 AWS_DEFAULT_REGION=cn-northwest-1
export AWS_STS_REGIONAL_ENDPOINTS=regional
export CDK_DEFAULT_ACCOUNT=<CN_ACCOUNT_ID> CDK_DEFAULT_REGION=cn-northwest-1

npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/cn-northwest-1
npx cdk synth keycloak-ha-cn-eks
npx cdk deploy --all --require-approval never   # network -> database -> eks (~20-25 min)
```

> - The `--profile` flag is not honored on all SDK code paths (context lookups) — use `AWS_PROFILE`.
> - `sts get-caller-identity` without `--region` fails with `InvalidClientTokenId` (global endpoint);
>   with `--region cn-northwest-1` it succeeds.

### Retry after a failed deploy (RETAIN secret)

If the eks stack fails and rolls back, `keycloak-ha-cn/keycloak/admin` (RETAIN) is kept and a
retry fails with `already exists`. Delete it before redeploying:
```bash
aws secretsmanager delete-secret --secret-id keycloak-ha-cn/keycloak/admin \
  --force-delete-without-recovery --region cn-northwest-1 --profile china
```

### HTTPS / KC_HOSTNAME (two-phase, same idea as the parent project)

- **With an ICP domain + ACM cert**: set `alb.certArn` + `alb.domainName`. `KC_HOSTNAME`
  becomes `https://<domain>` and the ALB does 80→443 redirect. Point DNS at the ALB DNS name
  (stack output `AlbDnsName`).
- **Testing without a domain (HTTP only)**: leave `alb.certArn` empty. After deploy, set
  `keycloak.publicUrl = http://<alb-dns>` and redeploy. Also, the Keycloak realm defaults to
  `sslRequired=external` and returns **"HTTPS required"** over HTTP from external clients. For
  testing only (revert + use HTTPS for prod):
  ```bash
  POD=$(kubectl get pods -n keycloak -l app=keycloak -o jsonpath='{.items[0].metadata.name}')
  kubectl exec -n keycloak $POD -c keycloak -- sh -c \
    '/opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "$(cat /creds/admin_pass)" && /opt/keycloak/bin/kcadm.sh update realms/master -s sslRequired=NONE'
  ```

## Post-deploy

```bash
aws eks update-kubeconfig --name keycloak-ha-cn --region cn-northwest-1
kubectl -n keycloak get pods,svc,targetgroupbinding,hpa
```
Admin password: Secrets Manager `keycloak-ha-cn/keycloak/admin`. Then configure the
`aws-realm`, OIDC/SAML clients, and the SAML provider/role using `signin.amazonaws.cn` —
see **[`USAGE-GUIDE.md`](./USAGE-GUIDE.md)** for the exact ZHY (`arn:aws-cn`) steps.

## Security note

- **ALB is locked by default**: `alb.allowedCidrs` defaults to `[]`, so the ALB security group
  has no inbound rules (nobody can reach it). Set your **egress CIDR(s)** (office/VPN) before
  deploy; do **not** use `0.0.0.0/0` (that exposes the IdP to the whole internet).
- **Credentials**: DB/admin passwords are injected at runtime into an in-memory volume by an
  IRSA init container — never in etcd, the CFN template, or the git repo.
- **HTTPS**: production must use HTTPS (ICP domain + cn-northwest-1 ACM cert). `sslRequired=NONE`
  is for testing only — revert to `external` and enable HTTPS before go-live.
- Consider adding AWS WAF (available in ZHY) to the ALB for production.
