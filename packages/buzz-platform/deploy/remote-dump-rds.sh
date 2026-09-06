#!/usr/bin/env bash
# Optional on-box dump if Postgres is reachable from the VPS. Prefer migrate-from-rds.sh (laptop dump + scp).
# Prefers DATABASE_URL. Otherwise builds it from RDS_HOST + Secrets Manager.
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-/opt/buzz/migrate}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
mkdir -p "${DUMP_DIR}"
chmod 700 "${DUMP_DIR}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  SECRET_ID="${DUMP_SECRET:-${BUZZ_LEGACY_SECRET_NAME:-buzz/platform}}"
  RAW="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ID}" --region "${REGION}" --query SecretString --output text)"
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
    host = os.environ["RDS_HOST"]
    port = os.environ.get("RDS_PORT", "5432")
    user = d.get("POSTGRES_USER") or d.get("username") or "buzz"
    pw = d.get("POSTGRES_PASSWORD") or d.get("password") or ""
    db = d.get("POSTGRES_DB") or d.get("dbname") or d.get("dbInstanceIdentifier") or "buzz"
    if not pw:
        raise SystemExit("no DATABASE_URL or password in secret")
    url = f"postgres://{user}:{pw}@{host}:{port}/{db}"
print(url)
' "${RAW}")"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
echo "Dumping Postgres to ${DUMP_DIR}/rds-${STAMP}.dump"
docker run --rm \
  --network host \
  -v "${DUMP_DIR}:/dump" \
  postgres:17-alpine \
  pg_dump --format=custom --no-owner --no-acl \
    --dbname="${DATABASE_URL}" \
    --file="/dump/rds-${STAMP}.dump"

ln -sfn "rds-${STAMP}.dump" "${DUMP_DIR}/latest.dump"
echo "WROTE ${DUMP_DIR}/rds-${STAMP}.dump"
ls -lh "${DUMP_DIR}/rds-${STAMP}.dump"
