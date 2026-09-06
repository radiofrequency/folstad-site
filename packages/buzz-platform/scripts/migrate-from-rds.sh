#!/usr/bin/env bash
# Snapshot live RDS, dump from the laptop, scp to Hetzner, restore into compose Postgres.
# Does not change DNS and does not delete anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

need aws
need python3
need docker
need ssh
need scp
require_account
relay_ip >/dev/null

RDS_ID="$(discover_rds)"
[[ -n "${RDS_ID}" && "${RDS_ID}" != "None" ]] || die "no RDS instance found (set BUZZ_RDS_ID)"

echo "RDS=${RDS_ID}"
echo "Hetzner=$(relay_ssh)"

RDS_JSON="$(aws rds describe-db-instances --db-instance-identifier "${RDS_ID}")"
RDS_HOST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["Endpoint"]["Address"])' <<<"${RDS_JSON}")"
RDS_PORT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["Endpoint"]["Port"])' <<<"${RDS_JSON}")"
RDS_SG="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["VpcSecurityGroups"][0]["VpcSecurityGroupId"])' <<<"${RDS_JSON}")"
PUBLIC="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0].get("PubliclyAccessible"))' <<<"${RDS_JSON}")"

SNAP_ID="${RDS_ID}-pre-hetzner-$(date -u +%Y%m%d%H%M)"
echo "Creating RDS snapshot ${SNAP_ID} (rollback point)"
aws rds create-db-snapshot \
  --db-instance-identifier "${RDS_ID}" \
  --db-snapshot-identifier "${SNAP_ID}" >/dev/null
aws rds wait db-snapshot-completed --db-snapshot-identifier "${SNAP_ID}"
echo "Snapshot ready: ${SNAP_ID}"

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
[[ -n "${MY_IP}" ]] || die "could not detect public IP for a temporary RDS SG hole"

echo "Opening ${RDS_SG}:5432 to ${MY_IP}/32 for the dump"
aws ec2 authorize-security-group-ingress \
  --group-id "${RDS_SG}" \
  --protocol tcp --port 5432 \
  --cidr "${MY_IP}/32" >/dev/null 2>&1 || true

if [[ "${PUBLIC}" != "True" ]]; then
  echo "RDS is not publicly accessible. Temporarily enabling PubliclyAccessible."
  aws rds modify-db-instance --db-instance-identifier "${RDS_ID}" --publicly-accessible --apply-immediately >/dev/null
  echo "Waiting for RDS to be available again"
  aws rds wait db-instance-available --db-instance-identifier "${RDS_ID}"
  RDS_JSON="$(aws rds describe-db-instances --db-instance-identifier "${RDS_ID}")"
  RDS_HOST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["DBInstances"][0]["Endpoint"]["Address"])' <<<"${RDS_JSON}")"
fi

cleanup() {
  aws ec2 revoke-security-group-ingress \
    --group-id "${RDS_SG}" --protocol tcp --port 5432 --cidr "${MY_IP}/32" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export RDS_HOST RDS_PORT
DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "${DATABASE_URL}" ]]; then
  RAW="$(aws secretsmanager get-secret-value --secret-id "${LEGACY_SECRET}" --query SecretString --output text 2>/dev/null || true)"
  if [[ -n "${RAW}" ]]; then
    DATABASE_URL="$(python3 -c '
import json, os, sys
raw = sys.argv[1]
try:
    d = json.loads(raw)
except json.JSONDecodeError:
    d = {}
    for line in raw.splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            d[k.strip()] = v.strip().strip("\"")
url = d.get("DATABASE_URL") or d.get("database_url") or ""
if not url:
    user = d.get("POSTGRES_USER") or d.get("username") or "buzz"
    pw = d.get("POSTGRES_PASSWORD") or d.get("password") or ""
    db = d.get("POSTGRES_DB") or d.get("dbname") or "buzz"
    if pw:
        url = f"postgres://{user}:{pw}@{os.environ["RDS_HOST"]}:{os.environ["RDS_PORT"]}/{db}"
print(url)
' "${RAW}")"
  fi
fi
[[ -n "${DATABASE_URL}" ]] || die "set DATABASE_URL=postgres://... or put it in secret ${LEGACY_SECRET}"

LOCAL_DUMP="$(mktemp /tmp/buzz-rds-XXXXXX.dump)"
echo "Dumping ${RDS_HOST}:${RDS_PORT} on the laptop → ${LOCAL_DUMP}"
docker run --rm \
  -v "$(dirname "${LOCAL_DUMP}"):/dump" \
  postgres:17-alpine \
  pg_dump --format=custom --no-owner --no-acl \
    --dbname="${DATABASE_URL}" \
    --file="/dump/$(basename "${LOCAL_DUMP}")"

echo "Copying dump to $(relay_ssh):${REMOTE_DIR}/migrate/latest.dump"
ssh_run "mkdir migrate" "mkdir -p ${REMOTE_DIR}/migrate && chmod 700 ${REMOTE_DIR}/migrate"
scp_to "${LOCAL_DUMP}" "${REMOTE_DIR}/migrate/latest.dump"
rm -f "${LOCAL_DUMP}"

echo "Restoring into compose Postgres"
ssh_run "restore" "chmod +x ${REMOTE_DIR}/remote-restore.sh && ${REMOTE_DIR}/remote-restore.sh"

if [[ "${WITH_REDIS:-}" == "1" ]]; then
  REDIS_ID="$(discover_redis)"
  echo "Redis dump skipped by default (communities live in Postgres). Cluster: ${REDIS_ID}"
fi

echo
echo "Migration copy finished."
echo "  snapshot: ${SNAP_ID}"
echo "Next: ./verify-relay.sh --ip  then  ./cutover-dns.sh"
