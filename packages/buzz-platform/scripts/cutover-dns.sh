#!/usr/bin/env bash
# Point relay.buzzftw.com and *.buzzftw.com at the Hetzner IPv4, then enable Caddy TLS.
# Does not touch apex or www (CloudFront marketing site).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

need aws
need python3
need ssh
require_account

IP="$(relay_ip)"
echo "Cutover ${RELAY_HOST} and *.${ZONE_NAME} -> ${IP}"
echo "Leaving ${ZONE_NAME} and www.${ZONE_NAME} unchanged"

upsert() {
  local name="$1"
  aws route53 change-resource-record-sets --hosted-zone-id "${ZONE_ID}" --change-batch "$(python3 -c '
import json,sys
name, ip = sys.argv[1], sys.argv[2]
fqdn = name if name.endswith(".") else name + "."
print(json.dumps({
  "Comment": "Buzz free-relay Hetzner cutover",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": fqdn,
      "Type": "A",
      "TTL": 60,
      "ResourceRecords": [{"Value": ip}],
    },
  }],
}))
' "${name}" "${IP}")"
}

upsert "${RELAY_HOST}"
upsert "*.${ZONE_NAME}"

echo "Waiting 90s for low TTL + ACME"
sleep 90

echo "Enabling Caddy TLS on Hetzner"
ssh_run "enable tls" "cd ${REMOTE_DIR} && sed -i 's/^BUZZ_HTTP_PORT=.*/BUZZ_HTTP_PORT=3000/' .env && mkdir -p /etc/systemd/system/buzz-relay.service.d && printf '[Service]\nEnvironment=BUZZ_COMPOSE_TLS=true\n' > /etc/systemd/system/buzz-relay.service.d/tls.conf && systemctl daemon-reload && export BUZZ_COMPOSE_TLS=true && ./run.sh start && ./run.sh status"

echo "HTTPS check"
"${ROOT}/verify-relay.sh" --dns
echo "DNS cutover complete."
