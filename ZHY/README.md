# Keycloak HA on AWS China (ZHY / cn-northwest-1)

Independent CDK project. Architecture: **ALB (public entry) → EKS (Graviton) → Aurora
PostgreSQL (Graviton)**. **No CloudFront** (China CloudFront requires ICP filing). All ARM.

This is the AWS China (`aws-cn`) adaptation of the us-west-2 deployment in the parent
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

## What differs from the us-west-2 version (China specifics)

| Area | Adaptation |
|------|-----------|
| Partition | `arn:aws-cn:*` applied automatically by CDK when `region = cn-northwest-1`. |
| Public entry | **ALB** (not CloudFront). HTTPS needs an ACM cert (cn-northwest-1) on an **ICP-filed** domain (`alb.certArn` + `alb.domainName`); otherwise HTTP only (testing). |
| ALB Controller image | **Must** come from the China regional ECR — `eks.albControllerRepository`. CDK otherwise defaults to a us-west-2 account unreachable from China. **Verify the account id** and that the chosen controller version tag exists in that repo. |
| Graviton classes | Defaults to `m6g.large` (nodes) and `r6g.large` (Aurora) — broadly available in cn-northwest-1. Verify before using `m7g`/`r7g`. |
| EKS version | Defaults to `1.32`. **Verify** with `aws eks describe-cluster-versions --region cn-northwest-1` and keep the `@aws-cdk/lambda-layer-kubectl-vXX` package (package.json) matched to it. |
| Keycloak image | `quay.io` is unreliable in China — push the image to ECR cn-northwest-1 and set `keycloak.image`. |
| CSI driver / provider images | Helm images pull from `registry.k8s.io` / `public.ecr.aws`; may be slow/blocked in China. Mirror to ECR if pulls fail. |
| Route 53 | Not offered in China — manage DNS at your registrar / China DNS provider; point your ICP domain at the ALB. |
| SAML federation | AWS sign-in is `https://signin.amazonaws.cn/saml` (configured later inside Keycloak). |

## Prerequisites

- AWS China account credentials for cn-northwest-1; CDK bootstrapped:
  ```bash
  npx cdk bootstrap aws://<CN_ACCOUNT_ID>/cn-northwest-1
  ```
- Edit `lib/config.ts`:
  - `eks.albControllerRepository` — verify the China ECR account id.
  - `eks.clusterAdminPrincipalArns` — **required**: your `arn:aws-cn:iam::...` admin
    principal(s). Both User ARNs (`...:user/...`) and Role ARNs (`...:role/...`) are
    accepted. If left empty, no human can `kubectl` into the cluster after deploy.
  - `eks.publicEndpointAllowedCidrs` — restrict the EKS public API endpoint.
  - `keycloak.image` — your ECR image URI.
  - `alb.allowedCidrs` / `alb.certArn` / `alb.domainName` — entry exposure & TLS.

## Customer pre-deployment checklist (AWS China)

Run through this before `cdk deploy` in a fresh AWS China account. Items marked **VERIFY**
cannot be assumed from outside China — confirm them in the cn-northwest-1 console/CLI first.

- [ ] **Tooling**: Node.js 18+, AWS CLI v2, `kubectl`, Docker running (CDK bundles assets in Docker).
- [ ] **Credentials**: point at the customer's **AWS China** account (`aws sts get-caller-identity`
      should return an `arn:aws-cn:...` identity).
- [ ] **Bootstrap**: `npx cdk bootstrap aws://<CN_ACCOUNT_ID>/cn-northwest-1`.
- [ ] **No stale context**: `cdk.context.json` and `cdk.out/` are absent (gitignored; regenerate on synth).
- [ ] **`lib/config.ts` filled in**:
  - [ ] `eks.clusterAdminPrincipalArns` = customer's `arn:aws-cn:iam::...` admin User/Role (else no kubectl access).
  - [ ] `eks.publicEndpointAllowedCidrs` = customer egress CIDRs (else EKS API is public).
  - [ ] `eks.albControllerRepository` = correct cn ECR (ZHY default `961992271922`; Beijing `918309763551`). **VERIFY**.
  - [ ] `keycloak.image` = customer's ECR image URI (quay.io is unreliable in China). **VERIFY** the image is pushed.
  - [ ] `alb.allowedCidrs` (tighten from `0.0.0.0/0` if internal) and, for HTTPS, `alb.certArn` + `alb.domainName` (ICP-filed).
  - [ ] `keycloak.publicUrl` = empty for first deploy (pinned on the second pass — see below).
- [ ] **VERIFY** ALB Controller image tag (`v2.8.2`) exists in the cn ECR repo above.
- [ ] **VERIFY** EKS version `1.32` is offered: `aws eks describe-cluster-versions --region cn-northwest-1`
      (keep `@aws-cdk/lambda-layer-kubectl-v32` in `package.json` matched to it).
- [ ] **VERIFY** Aurora PostgreSQL `16.4` + `r6g.large` and node `m6g.large` are available in cn-northwest-1.
- [ ] **VERIFY** EKS, Aurora, NAT/EIP quota headroom in the account.

## Deploy

```bash
npm install
npm run build
npx cdk synth
npx cdk deploy --all   # network -> database -> eks
```

### HTTPS / KC_HOSTNAME (two-phase, same idea as the parent project)

- **With an ICP domain + ACM cert**: set `alb.certArn` + `alb.domainName`. `KC_HOSTNAME`
  becomes `https://<domain>` automatically and the ALB does 80→443 redirect. Point your
  DNS at the ALB DNS name (stack output `AlbDnsName`).
- **Testing without a domain**: leave `alb.certArn` empty (HTTP only). After deploy, read
  `AlbDnsName`, set `keycloak.publicUrl = http://<alb-dns>` and redeploy so Keycloak emits
  correct URLs (avoids the admin-console "somethingWentWrong" / loading error).

## Post-deploy

```bash
aws eks update-kubeconfig --name keycloak-ha-cn --region cn-northwest-1
kubectl -n keycloak get pods,svc,targetgroupbinding,hpa
```
Admin password: Secrets Manager `keycloak-ha-cn/keycloak/admin`. Then configure the
`aws-realm`, OIDC/SAML clients, and the SAML provider/role using `signin.amazonaws.cn` —
see **[`USAGE-GUIDE.md`](./USAGE-GUIDE.md)** for the exact China (`arn:aws-cn`) steps.

## Security note

Without CloudFront the ALB is directly internet-facing. It is restricted to
`alb.allowedCidrs` (default `0.0.0.0/0` for a public IdP — tighten to corporate CIDRs if
internal). Consider adding AWS WAF (available in China) to the ALB for production.
