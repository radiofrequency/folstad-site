#!/usr/bin/env bash
# Snapshot live RDS, dump from the new EC2 (same VPC), restore into compose Postgres.
# Does not change DNS and does not delete anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

need aws
need python3
require_account

RDS_ID="$(discover_rds)"
[[ -n "${RDS_ID}" && "${RDS_ID}" != "None" ]] || die "no RDS instance found (set BUZZ_RDS_ID)"
INSTANCE_ID="$(relay_instance_id)"
[[ -n "${INSTANCE_ID}" && "${INSTANCE_ID}" != "None" ]] || die "buzz-relay EC2 not found — deploy CDK first"

echo "RDS=${RDS_ID}"
echo "EC2=${INSTANCE_ID}"

RDS_JSON="$(aws rds describe-db-instances --db-instance-identifier "${RDS_ID}")"
RDS_HOST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["Endpoint"]["Address"])' <<<"${RDS_JSON}")"
RDS_PORT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["Endpoint"]["Port"])' <<<"${RDS_JSON}")"
RDS_SG="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["VpcSecurityGroups"][0]["VpcSecurityGroupId"])' <<<"${RDS_JSON}")"
EC2_SG="$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" --output text)"

SNAP_ID="${RDS_ID}-pre-ec2-$(date -u +%Y%m%d%H%M)"
echo "Creating RDS snapshot ${SNAP_ID} (wait — this is the rollback point)"
aws rds create-db-snapshot \
  --db-instance-identifier "${RDS_ID}" \
  --db-snapshot-identifier "${SNAP_ID}" >/dev/null
aws rds wait db-snapshot-completed --db-snapshot-identifier "${SNAP_ID}"
echo "Snapshot ready: ${SNAP_ID}"

# Allow the relay box to reach RDS for the dump.
if ! aws ec2 describe-security-groups --group-ids "${RDS_SG}" \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`5432\`].UserIdGroupPairs[?GroupId=='${EC2_SG}']" \
  --output text | grep -q .; then
  echo "Opening ${RDS_SG}:5432 from ${EC2_SG}"
  aws ec2 authorize-security-group-ingress \
    --group-id "${RDS_SG}" \
    --protocol tcp --port 5432 \
    --source-group "${EC2_SG}" >/dev/null || true
fi

echo "Dumping ${RDS_HOST}:${RDS_PORT} from EC2 (credentials stay on the instance)"
DUMP_SECRET="${LEGACY_SECRET}"
if ! aws secretsmanager describe-secret --secret-id "${LEGACY_SECRET}" >/dev/null 2>&1; then
  DUMP_SECRET="${SECRET_NAME}"
fi
ssm_run "buzz rds dump" "export AWS_REGION=${AWS_REGION} RDS_HOST=${RDS_HOST} RDS_PORT=${RDS_PORT} DUMP_SECRET=${DUMP_SECRET}; chmod +x /opt/buzz/remote-dump-rds.sh; /opt/buzz/remote-dump-rds.sh"

echo "Restoring dump into compose Postgres"
ssm_run "buzz rds restore" "chmod +x /opt/buzz/remote-restore.sh; /opt/buzz/remote-restore.sh"

if [[ "${WITH_REDIS:-}" == "1" ]]; then
  REDIS_ID="$(discover_redis)"
  if [[ -n "${REDIS_ID}" && "${REDIS_ID}" != "None" ]]; then
    echo "Redis dump/restore is best-effort. Communities usually live in Postgres."
    echo "To skip a cold Redis start, copy an RDB via SSM after opening 6379 from ${EC2_SG}."
    echo "Redis cluster: ${REDIS_ID}"
  fi
fi

echo
echo "Migration copy finished."
echo "  snapshot: ${SNAP_ID}"
echo "Next: ./verify-relay.sh --ip  then  ./cutover-dns.sh"
