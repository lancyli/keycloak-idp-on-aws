#!/usr/bin/env bash
#
# deploy.sh — One-command deploy of the Keycloak HA stack to us-west-2.
#
# Runs the full flow: build -> bootstrap -> deploy --all, then automatically pins
# KC_HOSTNAME to the CloudFront URL (the "two-pass" step) and redeploys the eks stack.
# The AWS account id is auto-detected from your credentials (never hard-coded), so this
# script contains no account-specific / sensitive data and is safe to commit.
#
# Usage (run from the us-west-2/ directory):
#   AWS_PROFILE=<profile> ./deploy.sh all           # full deploy incl. hostname pin (default)
#   AWS_PROFILE=<profile> ./deploy.sh deploy        # first pass only: build + bootstrap + deploy --all
#   AWS_PROFILE=<profile> ./deploy.sh pin-hostname  # read CloudFront URL -> set publicUrl -> redeploy eks
#   AWS_PROFILE=<profile> ./deploy.sh password      # print the Keycloak admin password
#
# Optional env:
#   AWS_PROFILE   AWS CLI profile (default: the default credential chain)
#   REGION        target region (default: us-west-2)
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-}"
REGION="${REGION:-us-west-2}"
CMD="${1:-all}"
PROF=(); [ -n "$PROFILE" ] && PROF=(--profile "$PROFILE")

# Pin the SDK/CLI to the target region (the ambient AWS_REGION may point elsewhere).
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH"; }

[ -f cdk.json ] || die "run this script from the us-west-2/ directory (cdk.json not found here)"

resolve_account() {
  ACCOUNT="$(aws sts get-caller-identity "${PROF[@]}" --query Account --output text 2>/dev/null || true)"
  case "${ACCOUNT:-}" in ''|None) die "cannot resolve account — check your AWS credentials/profile";; esac
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION"
}

first_deploy() {
  need npx; need aws
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || \
    log "NOTE: docker is not running — usually fine, but CDK asset bundling may need it."
  resolve_account
  log "Account $ACCOUNT — region $REGION"

  if grep -qE 'clusterAdminPrincipalArns:[[:space:]]*\[\]' lib/config.ts 2>/dev/null; then
    log "WARNING: eks.clusterAdminPrincipalArns is EMPTY in lib/config.ts."
    log "         You will have NO kubectl/console admin access after deploy."
    if [ -t 0 ]; then printf 'Continue anyway? [y/N] '; read -r a; [ "$a" = "y" ] || die "aborted by user"; fi
  fi

  log "npm install"; npm install
  log "npm run build"; npm run build
  log "cdk bootstrap (idempotent)"; npx cdk bootstrap "${PROF[@]}" "aws://${ACCOUNT}/${REGION}"
  log "cdk deploy --all (~25-35 min: network -> database -> eks -> cloudfront)"
  npx cdk deploy --all --require-approval never "${PROF[@]}"
}

# Second pass: read the CloudFront URL and pin it as KC_HOSTNAME, then redeploy the eks stack.
pin_hostname() {
  need npx; need aws
  resolve_account
  log "Reading CloudFront public URL from stack outputs"
  URL="$(aws cloudformation describe-stacks --stack-name keycloak-ha-cloudfront "${PROF[@]}" \
          --query "Stacks[0].Outputs[?OutputKey=='KeycloakPublicUrl'].OutputValue" --output text 2>/dev/null || true)"
  case "${URL:-}" in
    ''|None) die "KeycloakPublicUrl output not found — run '$0 deploy' first";;
  esac
  log "CloudFront URL: $URL"

  if grep -qE "publicUrl:[[:space:]]*'${URL//\//\\/}'" lib/config.ts; then
    log "publicUrl already pinned — nothing to do."
    return 0
  fi
  log "Pinning keycloak.publicUrl in lib/config.ts"
  perl -i -pe "s#(publicUrl:[[:space:]]*)'[^']*'#\${1}'${URL}'#" lib/config.ts
  grep -nE "publicUrl:[[:space:]]*'" lib/config.ts | head -1

  log "npm run build"; npm run build
  log "Redeploying keycloak-ha-eks to apply KC_HOSTNAME"
  npx cdk deploy keycloak-ha-eks --require-approval never "${PROF[@]}"
  log "KC_HOSTNAME pinned to $URL"
}

show_password() {
  need aws
  log "Keycloak admin credentials"
  echo "username: admin"
  printf 'password: '
  aws secretsmanager get-secret-value --secret-id keycloak-ha/keycloak/admin "${PROF[@]}" \
    --region "$REGION" --query SecretString --output text 2>/dev/null \
    | sed -n 's/.*"password":"\([^"]*\)".*/\1/p' || die "admin secret not found"
}

case "$CMD" in
  all)          first_deploy; pin_hostname ;;
  deploy)       first_deploy ;;
  pin-hostname) pin_hostname ;;
  password)     show_password ;;
  *) die "usage: $0 {all|deploy|pin-hostname|password}" ;;
esac
