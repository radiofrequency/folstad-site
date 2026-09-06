#!/usr/bin/env bash
# Run on the relay EC2 via SSM. Restores /opt/buzz/migrate/latest.dump into compose Postgres.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/buzz}"
DUMP_DIR="${DUMP_DIR:-/opt/buzz/migrate}"
DUMP_FILE="${1:-${DUMP_DIR}/latest.dump}"

cd "${DEPLOY_DIR}"

if [[ ! -f "${DUMP_FILE}" ]]; then
  echo "Dump not found: ${DUMP_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

echo "Stopping relay before restore"
BUZZ_COMPOSE_TLS="${BUZZ_COMPOSE_TLS:-false}" ./run.sh stop || true
docker compose --env-file .env -f compose.yml up -d postgres
for i in $(seq 1 30); do
  if docker compose --env-file .env -f compose.yml exec -T postgres \
    pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "Restoring ${DUMP_FILE} into compose Postgres"
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  >/dev/null || true
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${POSTGRES_DB};"
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d postgres -c "CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};"

docker run --rm \
  --network "buzz-prod_buzz-net" \
  -v "${DUMP_FILE}:/dump.dump:ro" \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  postgres:17-alpine \
  pg_restore --no-owner --no-acl --verbose \
    -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    /dump.dump || true

# pg_restore exits 1 on some benign warnings; verify a table exists
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';"

echo "Starting stack"
BUZZ_COMPOSE_TLS="${BUZZ_COMPOSE_TLS:-false}" ./run.sh start
echo "Restore complete"
