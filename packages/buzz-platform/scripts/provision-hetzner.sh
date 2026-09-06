#!/usr/bin/env bash
# Create (optional) a Hetzner CX22 Ubuntu box and install the Buzz compose stack.
# Does not touch Route53 or AWS. No LNbits.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

DEPLOY_SRC="$(cd "${ROOT}/../deploy" && pwd)"
HCLOUD_TYPE="${HCLOUD_TYPE:-cx22}"
HCLOUD_LOCATION="${HCLOUD_LOCATION:-ash}"
HCLOUD_IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
HCLOUD_NAME="${HCLOUD_NAME:-buzz-relay}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0

Uses an existing VPS when HETZNER_IP is set. Otherwise runs:
  hcloud server create --name ${HCLOUD_NAME} --type ${HCLOUD_TYPE} \\
    --image ${HCLOUD_IMAGE} --location ${HCLOUD_LOCATION}

Then SSH-installs Docker, rsyncs packages/buzz-platform/deploy → ${REMOTE_DIR},
and runs bootstrap.sh (compose without Caddy until DNS cutover).
EOF
  exit 0
fi

need ssh
need scp
need rsync

if [[ -z "${HETZNER_IP:-}" ]]; then
  need hcloud
  [[ -n "${HCLOUD_SSH_KEY:-}" ]] || die "set HCLOUD_SSH_KEY to an hcloud ssh-key name, or set HETZNER_IP"
  echo "Creating ${HCLOUD_NAME} (${HCLOUD_TYPE} ${HCLOUD_IMAGE} @ ${HCLOUD_LOCATION})"
  echo "Restrict the Hetzner firewall to 22/80/443 after first SSH works."
  hcloud server create \
    --name "${HCLOUD_NAME}" \
    --type "${HCLOUD_TYPE}" \
    --image "${HCLOUD_IMAGE}" \
    --location "${HCLOUD_LOCATION}" \
    --ssh-key "${HCLOUD_SSH_KEY}"
  HETZNER_IP="$(hcloud server ip "${HCLOUD_NAME}")"
  echo "HETZNER_IP=${HETZNER_IP}"
  mkdir -p "${ROOT}"
  if [[ ! -f "${ROOT}/.relay.env" ]]; then
    printf 'HETZNER_IP=%s\nBUZZ_SSH=root@%s\n' "${HETZNER_IP}" "${HETZNER_IP}" > "${ROOT}/.relay.env"
    echo "Wrote ${ROOT}/.relay.env"
  fi
  echo "Waiting for SSH"
  for _ in $(seq 1 30); do
    if ssh "${SSH_OPTS[@]}" "root@${HETZNER_IP}" true 2>/dev/null; then
      break
    fi
    sleep 5
  done
fi

echo "Installing Docker on $(relay_ssh)"
ssh_run "apt docker" 'export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 rsync curl python3 openssl
  systemctl enable --now docker
fi
mkdir -p /opt/buzz /opt/buzz/migrate
'

echo "Copying compose bundle to ${REMOTE_DIR}"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.env' --exclude 'migrate/' --exclude '__pycache__/' \
  "${DEPLOY_SRC}/" "$(relay_ssh):${REMOTE_DIR}/"

SEED=""
if command -v aws >/dev/null && aws sts get-caller-identity >/dev/null 2>&1; then
  if aws secretsmanager describe-secret --secret-id "${LEGACY_SECRET}" >/dev/null 2>&1; then
    echo "Seeding relay keys from ${LEGACY_SECRET}"
    aws secretsmanager get-secret-value --secret-id "${LEGACY_SECRET}" \
      --query SecretString --output text > /tmp/buzz-seed.json
    scp_to /tmp/buzz-seed.json "${REMOTE_DIR}/seed.json"
    rm -f /tmp/buzz-seed.json
    SEED=1
  fi
fi

ssh_run "bootstrap" "chmod +x ${REMOTE_DIR}/*.sh ${REMOTE_DIR}/*.py
export BUZZ_COMPOSE_TLS=false
${SEED:+export SEED_JSON=${REMOTE_DIR}/seed.json}
${REMOTE_DIR}/bootstrap.sh
cat >/etc/systemd/system/buzz-relay.service <<'UNIT'
[Unit]
Description=Buzz free relay (docker compose)
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/buzz
Environment=BUZZ_COMPOSE_TLS=false
ExecStart=/opt/buzz/run.sh start
ExecStop=/opt/buzz/run.sh stop
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable buzz-relay.service
"

echo
echo "Hetzner relay is up on http://$(relay_ip)/ (no TLS yet)."
echo "Next: ./migrate-from-rds.sh && ./verify-relay.sh --ip"
