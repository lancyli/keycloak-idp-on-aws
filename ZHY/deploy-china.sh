#!/usr/bin/env bash
#
# deploy-china.sh — Prepare & deploy the Keycloak HA stack to AWS ZHY (cn-northwest-1).
#
# Automates the ZHY-specific steps a plain `cdk deploy` cannot do:
#   - mirrors the Keycloak + aws-cli images from quay.io / public.ecr.aws into YOUR ECR
#   - downloads the AWS Load Balancer Controller Helm chart into charts/ (git-ignored)
#   - forces the regional STS endpoint + explicit account/region so cdk works in aws-cn
#
# The ZHY account id is auto-detected from the AWS profile (never hard-coded), so this
# script contains no account-specific / sensitive data and is safe to commit.
#
# Usage (run from the ZHY/ directory):
#   AWS_PROFILE=china ./deploy-china.sh all           # prep (mirror + chart) then deploy
#   AWS_PROFILE=china ./deploy-china.sh prep          # only mirror images + pull chart (needs Internet)
#   AWS_PROFILE=china ./deploy-china.sh deploy        # only build + bootstrap + deploy (needs ZHY creds)
#   AWS_PROFILE=china ./deploy-china.sh pin-hostname   # pin KC_HOSTNAME (publicUrl) and redeploy the eks stack
#   AWS_PROFILE=china ./deploy-china.sh clean-secret  # delete the retained admin secret before a retry
#
# pin-hostname URL selection:
#   - PUBLIC_URL env, if set (e.g. PUBLIC_URL=https://idp.example.cn for an ICP domain + HTTPS), else
#   - http://<ALB DNS> read from the eks stack output (HTTP testing).
#
# Optional env overrides:
#   AWS_PROFILE        AWS CLI profile for the ZHY account   (default: china)
#   REGION             AWS ZHY region                        (default: cn-northwest-1)
#   KEYCLOAK_TAG       Keycloak image tag to mirror            (default: 26.6.4)
#   ALB_CHART_VERSION  aws-load-balancer-controller chart ver  (default: 1.17.1)
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-china}"
REGION="${REGION:-cn-northwest-1}"
KEYCLOAK_TAG="${KEYCLOAK_TAG:-26.6.4}"
ALB_CHART_VERSION="${ALB_CHART_VERSION:-1.17.1}"
CMD="${1:-all}"

# ZHY needs the regional STS endpoint for BOTH the CLI and the CDK Node SDK.
export AWS_PROFILE
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
export AWS_STS_REGIONAL_ENDPOINTS=regional

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH"; }

[ -f cdk.json ] || die "run this script from the ZHY/ directory (cdk.json not found here)"

# Resolve the ZHY account id via the regional STS endpoint (no hard-coding).
resolve_account() {
  ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" \
              --query Account --output text 2>/dev/null || true)"
  case "${ACCOUNT:-}" in
    ''|None) die "cannot resolve account id — is the '$PROFILE' profile set up for the ZHY account?";;
  esac
  ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com.cn"
}

prep() {
  need docker; need helm; need aws
  docker info >/dev/null 2>&1 || die "docker daemon is not running"
  resolve_account
  log "Account $ACCOUNT — ECR registry $ECR"

  log "Ensuring ECR repositories exist (keycloak, aws-cli)"
  for repo in keycloak aws-cli; do
    aws ecr describe-repositories --repository-names "$repo" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 \
      || aws ecr create-repository --repository-name "$repo" --region "$REGION" --profile "$PROFILE" >/dev/null
  done

  log "Logging in to ECR"
  aws ecr get-login-password --region "$REGION" --profile "$PROFILE" \
    | docker login --username AWS --password-stdin "$ECR"

  log "Mirroring Keycloak (arm64) -> $ECR/keycloak:$KEYCLOAK_TAG"
  docker pull --platform linux/arm64 "quay.io/keycloak/keycloak:${KEYCLOAK_TAG}"
  docker tag  "quay.io/keycloak/keycloak:${KEYCLOAK_TAG}" "$ECR/keycloak:${KEYCLOAK_TAG}"
  docker push "$ECR/keycloak:${KEYCLOAK_TAG}"

  log "Mirroring aws-cli init image (arm64) -> $ECR/aws-cli:latest"
  docker pull --platform linux/arm64 public.ecr.aws/aws-cli/aws-cli:latest
  docker tag  public.ecr.aws/aws-cli/aws-cli:latest "$ECR/aws-cli:latest"
  docker push "$ECR/aws-cli:latest"

  log "Downloading LB Controller chart $ALB_CHART_VERSION -> charts/ (git-ignored)"
  mkdir -p charts
  helm pull aws-load-balancer-controller --repo https://aws.github.io/eks-charts \
    --version "$ALB_CHART_VERSION" -d charts/
  tar xzf "charts/aws-load-balancer-controller-${ALB_CHART_VERSION}.tgz" -C charts/
  [ -f charts/aws-load-balancer-controller/Chart.yaml ] || die "chart extraction failed"

  log "Prep complete."
}

deploy() {
  need npx; need aws
  [ -d charts/aws-load-balancer-controller ] || die "charts/ missing — run '$0 prep' first"
  resolve_account
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION"
  log "Account $ACCOUNT — region $REGION — profile $PROFILE"

  # Guard: empty clusterAdminPrincipalArns means no kubectl/console admin access.
  if grep -qE 'clusterAdminPrincipalArns:[[:space:]]*\[\]' lib/config.ts 2>/dev/null; then
    log "WARNING: eks.clusterAdminPrincipalArns is EMPTY in lib/config.ts."
    log "         You will have NO kubectl/console admin access after deploy."
    if [ -t 0 ]; then
      printf 'Continue anyway? [y/N] '; read -r ans; [ "$ans" = "y" ] || die "aborted by user"
    fi
  fi

  log "npm install"; npm install
  log "npm run build"; npm run build
  log "cdk bootstrap (idempotent)"; npx cdk bootstrap "aws://${ACCOUNT}/${REGION}"
  log "cdk deploy --all (~20-25 min: network -> database -> eks)"
  npx cdk deploy --all --require-approval never

  log "Deploy complete. ALB DNS is in the stack outputs above."
  log "Reminder: ALB SG is locked to alb.allowedCidrs; set your egress CIDR if empty."
}

# Delete the RETAIN admin secret so a failed-and-rolled-back stack can be recreated.
clean_secret() {
  need aws
  local name="keycloak-ha-cn/keycloak/admin"
  log "Deleting retained secret $name (force, no recovery window)"
  aws secretsmanager delete-secret --secret-id "$name" \
    --force-delete-without-recovery --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 \
    && log "deleted" || log "not present (nothing to do)"
}

# Pin KC_HOSTNAME (keycloak.publicUrl) and redeploy the eks stack.
# For HTTP testing this is optional (empty publicUrl -> hostname is derived from forwarded headers).
# It becomes useful once you serve Keycloak on a fixed URL (an ICP domain over HTTPS, or a pinned ALB DNS).
pin_hostname() {
  need npx; need aws; need perl
  resolve_account
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION"

  local url="${PUBLIC_URL:-}"
  if [ -z "$url" ]; then
    log "No PUBLIC_URL given — reading ALB DNS from the eks stack output (HTTP testing URL)"
    local albdns
    albdns="$(aws cloudformation describe-stacks --stack-name keycloak-ha-cn-eks --region "$REGION" --profile "$PROFILE" \
      --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text 2>/dev/null || true)"
    case "${albdns:-}" in ''|None) die "AlbDnsName output not found — run '$0 deploy' first";; esac
    url="http://${albdns}"
  fi
  log "Will pin keycloak.publicUrl = $url"

  # IMPORTANT: redeploying the eks stack reconciles the ALB security group to config.alb.allowedCidrs.
  # If you added ingress rules to the ALB SG by hand, put them in config.alb.allowedCidrs FIRST,
  # otherwise this redeploy will remove them and you will lose browser access.
  if grep -qE 'allowedCidrs:[[:space:]]*\[\]' lib/config.ts 2>/dev/null; then
    log "WARNING: alb.allowedCidrs is EMPTY in lib/config.ts."
    log "         Redeploying will reconcile the ALB SG to NO ingress and drop any hand-added rules."
    log "         Put your egress CIDR in alb.allowedCidrs before continuing, or re-add the SG rule after."
    if [ -t 0 ]; then printf 'Continue anyway? [y/N] '; read -r ans; [ "$ans" = "y" ] || die "aborted by user"; fi
  fi

  log "Pinning keycloak.publicUrl in lib/config.ts"
  perl -i -pe "s#(publicUrl:[[:space:]]*)'[^']*'#\${1}'${url}'#" lib/config.ts
  grep -nE "publicUrl:[[:space:]]*'" lib/config.ts | head -1

  log "npm run build"; npm run build
  log "Redeploying keycloak-ha-cn-eks to apply KC_HOSTNAME"
  npx cdk deploy keycloak-ha-cn-eks --require-approval never
  log "KC_HOSTNAME pinned to $url"
}

case "$CMD" in
  prep)         prep ;;
  deploy)       deploy ;;
  all)          prep; deploy ;;
  pin-hostname) pin_hostname ;;
  clean-secret) clean_secret ;;
  *) die "usage: $0 {all|prep|deploy|pin-hostname|clean-secret}" ;;
esac
