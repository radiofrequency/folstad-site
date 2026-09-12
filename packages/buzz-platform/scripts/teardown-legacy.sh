#!/usr/bin/env bash
# Tear down Fargate platform / LNbits / ALB-for-relay extras / RDS / ElastiCache.
# Default is dry-run. Refuses to delete without a verified-healthy flag.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

DRY_RUN=1
VERIFIED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --execute) DRY_RUN=0; shift ;;
    --i-verified-relay-healthy) VERIFIED=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--dry-run|--execute --i-verified-relay-healthy]

Deletes only the expensive BuzzFTW path:
  ECS services buzz-platform, lnbits (cluster ${CLUSTER})
  RDS platform Postgres (after a final snapshot)
  ElastiCache buzz-redis
  LNbits EFS (name contains lnbits)
  idle target groups / listener rules for *.buzzftw.com and lnbits.*

Keeps:
  Cognito, DynamoDB buzz-projects, operator HTTP API, config bucket
  ECR buzz-runtime, ECS cluster, Buzz project ALB (*.folstad.ca hosts, live AWS)
  buzzftw.com / www CloudFront + S3 marketing
  Route53 zone ${ZONE_NAME}
  the Hetzner VPS and its /opt/buzz data
EOF
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

need aws
need python3
require_account

run() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "DRY-RUN $*"
  else
    echo "+ $*"
    "$@"
  fi
}

echo "Mode: $([[ "${DRY_RUN}" -eq 1 ]] && echo DRY-RUN || echo EXECUTE)"
if [[ "${DRY_RUN}" -eq 0 && "${VERIFIED}" -ne 1 ]]; then
  die "refusing --execute without --i-verified-relay-healthy (run verify-relay.sh --dns first)"
fi
if [[ "${DRY_RUN}" -eq 0 ]]; then
  "${ROOT}/verify-relay.sh" --dns || die "relay not healthy; aborting teardown"
fi

RDS_ID="$(discover_rds)"
REDIS_ID="$(discover_redis)"

echo "--- planned targets ---"
echo "ECS cluster: ${CLUSTER}"
aws ecs list-services --cluster "${CLUSTER}" --output text || true
echo "RDS: ${RDS_ID}"
echo "Redis: ${REDIS_ID}"
aws elasticfilesystem describe-file-systems \
  --query "FileSystems[?contains(Name, 'lnbits') || contains(Name, 'Lnbits')].[FileSystemId,Name]" \
  --output text 2>/dev/null || true

for svc in buzz-platform lnbits; do
  if aws ecs describe-services --cluster "${CLUSTER}" --services "${svc}" \
    --query "services[?status!='INACTIVE'].serviceName" --output text 2>/dev/null | grep -q .; then
    run aws ecs update-service --cluster "${CLUSTER}" --service "${svc}" --desired-count 0
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      aws ecs wait services-stable --cluster "${CLUSTER}" --services "${svc}" || true
    fi
    run aws ecs delete-service --cluster "${CLUSTER}" --service "${svc}" --force
  else
    echo "skip ECS service ${svc} (absent)"
  fi
done

if [[ -n "${REDIS_ID}" && "${REDIS_ID}" != "None" ]]; then
  run aws elasticache delete-cache-cluster --cache-cluster-id "${REDIS_ID}"
fi

if [[ -n "${RDS_ID}" && "${RDS_ID}" != "None" ]]; then
  FINAL_SNAP="${RDS_ID}-final-$(date -u +%Y%m%d%H%M)"
  run aws rds delete-db-instance \
    --db-instance-identifier "${RDS_ID}" \
    --final-db-snapshot-identifier "${FINAL_SNAP}" \
    --delete-automated-backups
fi

# LNbits EFS
while read -r fs_id fs_name; do
  [[ -z "${fs_id}" ]] && continue
  echo "LNbits EFS ${fs_id} ${fs_name}"
  while read -r mt; do
    [[ -z "${mt}" ]] && continue
    run aws efs delete-mount-target --mount-target-id "${mt}"
  done < <(aws efs describe-mount-targets --file-system-id "${fs_id}" --query "MountTargets[].MountTargetId" --output text | tr '\t' '\n')
  run aws efs delete-file-system --file-system-id "${fs_id}"
done < <(aws elasticfilesystem describe-file-systems \
  --query "FileSystems[?contains(Name, 'lnbits') || contains(Name, 'Lnbits')].[FileSystemId,Name]" \
  --output text 2>/dev/null || true)

# Listener rules that only existed for BuzzFTW hosts
ALB_ARN="$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'Buzz')].LoadBalancerArn | [0]" --output text || true)"
if [[ -n "${ALB_ARN}" && "${ALB_ARN}" != "None" ]]; then
  LISTENER_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "${ALB_ARN}" \
    --query "Listeners[?Port==\`443\` || Port==\`80\`].ListenerArn" --output text)"
  for lis in ${LISTENER_ARN}; do
    aws elbv2 describe-rules --listener-arn "${lis}" --output json | python3 -c '
import json,sys
data=json.load(sys.stdin)
for rule in data.get("Rules",[]):
    if rule.get("IsDefault"):
        continue
    hosts=[]
    for c in rule.get("Conditions",[]):
        vals=(c.get("HostHeaderConfig") or {}).get("Values") or c.get("Values") or []
        hosts.extend(vals)
    blob=" ".join(hosts)
    if "buzzftw.com" in blob or "lnbits" in blob:
        print(rule["RuleArn"])
' | while read -r rule_arn; do
      [[ -z "${rule_arn}" ]] && continue
      run aws elbv2 delete-rule --rule-arn "${rule_arn}"
    done
  done
fi

echo
echo "Teardown step finished ($([[ "${DRY_RUN}" -eq 1 ]] && echo dry-run || echo executed))."
echo "Not deleted (on purpose): Cognito, DynamoDB, API Gateway, Buzz project ALB/ECS cluster,"
echo "marketing CloudFront/S3, Route53 zone, Hetzner VPS."
echo "If the shared ALB is unused after this, remove it in a later CDK deploy — do not"
echo "cdk destroy BuzzStack (that would delete the control plane)."
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo
  echo "To execute after Desktop joins ${RELAY_HOST}:"
  echo "  $0 --execute --i-verified-relay-healthy"
fi
