#!/usr/bin/env bash
# Shared helpers for Buzz Hetzner migration (laptop: buzz-deploy AWS + SSH to the VPS).
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export AWS_PAGER=""

CLUSTER="${BUZZ_ECS_CLUSTER:-buzz}"
ZONE_ID="${BUZZ_FTW_ZONE_ID:-Z03673022RSY2XVF548I0}"
ZONE_NAME="${BUZZ_FTW_ZONE_NAME:-buzzftw.com}"
RELAY_HOST="${BUZZ_RELAY_HOST:-relay.buzzftw.com}"
LEGACY_SECRET="${BUZZ_LEGACY_SECRET_NAME:-buzz/platform}"
REMOTE_DIR="${BUZZ_REMOTE_DIR:-/opt/buzz}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.relay.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.relay.env"
fi

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "${BUZZ_SSH_KEY:-}" ]]; then
  SSH_OPTS+=(-i "${BUZZ_SSH_KEY}")
fi

die() { echo "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null || die "missing command: $1"; }

require_account() {
  local id
  id="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || die "AWS credentials failed (use buzz-deploy)"
  if [[ "${id}" != "217074483639" && "${ALLOW_OTHER_ACCOUNT:-}" != "1" ]]; then
    die "expected account 217074483639, got ${id} (set ALLOW_OTHER_ACCOUNT=1 to override)"
  fi
  echo "AWS account ${id} region ${AWS_REGION}"
}

relay_ip() {
  if [[ -n "${HETZNER_IP:-}" ]]; then
    echo "${HETZNER_IP}"
    return
  fi
  die "set HETZNER_IP (or scripts/.relay.env) to the VPS public IPv4"
}

relay_ssh() {
  if [[ -n "${BUZZ_SSH:-}" ]]; then
    echo "${BUZZ_SSH}"
    return
  fi
  echo "root@$(relay_ip)"
}

ssh_run() {
  local comments="$1"
  local script="$2"
  echo "SSH $(relay_ssh): ${comments}" >&2
  ssh "${SSH_OPTS[@]}" "$(relay_ssh)" "bash -lc $(printf '%q' "${script}")"
}

scp_to() {
  scp "${SSH_OPTS[@]}" "$1" "$(relay_ssh):$2"
}

discover_rds() {
  if [[ -n "${BUZZ_RDS_ID:-}" ]]; then
    echo "${BUZZ_RDS_ID}"
    return
  fi
  aws rds describe-db-instances \
    --query "DBInstances[?contains(DBInstanceIdentifier, 'platformpostgres') || contains(DBInstanceIdentifier, 'buzz')].DBInstanceIdentifier | [0]" \
    --output text
}

discover_redis() {
  if [[ -n "${BUZZ_REDIS_ID:-}" ]]; then
    echo "${BUZZ_REDIS_ID}"
    return
  fi
  aws elasticache describe-cache-clusters \
    --query "CacheClusters[?contains(CacheClusterId, 'buzz-redis')].CacheClusterId | [0]" \
    --output text
}
