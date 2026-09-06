#!/usr/bin/env bash
# Shared helpers for Buzz EC2 migration scripts (run on Ryan's Mac with buzz-deploy).
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export AWS_PAGER=""

CLUSTER="${BUZZ_ECS_CLUSTER:-buzz}"
STACK="${BUZZ_STACK_NAME:-BuzzStack}"
ZONE_ID="${BUZZ_FTW_ZONE_ID:-Z03673022RSY2XVF548I0}"
ZONE_NAME="${BUZZ_FTW_ZONE_NAME:-buzzftw.com}"
RELAY_HOST="${BUZZ_RELAY_HOST:-relay.buzzftw.com}"
SECRET_NAME="${BUZZ_SECRET_NAME:-buzz/relay-ec2}"
LEGACY_SECRET="${BUZZ_LEGACY_SECRET_NAME:-buzz/platform}"

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

cfn_output() {
  aws cloudformation describe-stacks --stack-name "${STACK}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

relay_instance_id() {
  if [[ -n "${BUZZ_INSTANCE_ID:-}" ]]; then
    echo "${BUZZ_INSTANCE_ID}"
    return
  fi
  local from_cfn
  from_cfn="$(cfn_output OutRelayInstanceId 2>/dev/null || true)"
  if [[ -n "${from_cfn}" && "${from_cfn}" != "None" ]]; then
    echo "${from_cfn}"
    return
  fi
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=buzz-relay" "Name=instance-state-name,Values=running,pending" \
    --query "Reservations[0].Instances[0].InstanceId" --output text
}

relay_eip() {
  if [[ -n "${BUZZ_RELAY_EIP:-}" ]]; then
    echo "${BUZZ_RELAY_EIP}"
    return
  fi
  local from_cfn
  from_cfn="$(cfn_output OutRelayEip 2>/dev/null || true)"
  if [[ -n "${from_cfn}" && "${from_cfn}" != "None" ]]; then
    echo "${from_cfn}"
    return
  fi
  local iid
  iid="$(relay_instance_id)"
  aws ec2 describe-instances --instance-ids "${iid}" \
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text
}

wait_ssm() {
  local cmd_id="$1"
  aws ssm wait command-executed --command-id "${cmd_id}" --instance-id "$(relay_instance_id)" || true
  local status
  status="$(aws ssm get-command-invocation --command-id "${cmd_id}" --instance-id "$(relay_instance_id)" \
    --query Status --output text)"
  aws ssm get-command-invocation --command-id "${cmd_id}" --instance-id "$(relay_instance_id)" \
    --query "[StandardOutputContent,StandardErrorContent]" --output text
  [[ "${status}" == "Success" ]] || die "SSM command ${cmd_id} status=${status}"
}

ssm_run() {
  local iid comments script cmd_id
  iid="$(relay_instance_id)"
  [[ -n "${iid}" && "${iid}" != "None" ]] || die "could not find buzz-relay instance"
  comments="$1"
  script="$2"
  cmd_id="$(aws ssm send-command \
    --instance-ids "${iid}" \
    --document-name AWS-RunShellScript \
    --comment "${comments}" \
    --parameters commands="${script}" \
    --query Command.CommandId --output text)"
  echo "SSM ${cmd_id} on ${iid}: ${comments}" >&2
  wait_ssm "${cmd_id}"
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
