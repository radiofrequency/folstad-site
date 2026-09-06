#!/usr/bin/env bash
# Health-check the free relay on the Hetzner IP (pre-DNS) or relay.buzzftw.com (post-cutover).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/common.sh"

MODE="auto"
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) MODE="ip"; shift ;;
    --dns) MODE="dns"; shift ;;
    --url) TARGET="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--ip|--dns|--url URL]"
      echo "Set HETZNER_IP or scripts/.relay.env"
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

need curl

if [[ -z "${TARGET}" ]]; then
  if [[ "${MODE}" == "dns" ]]; then
    TARGET="https://${RELAY_HOST}"
  elif [[ "${MODE}" == "ip" ]]; then
    TARGET="http://$(relay_ip)"
  else
    if curl -fsS --max-time 8 "https://${RELAY_HOST}/_liveness" >/dev/null 2>&1; then
      TARGET="https://${RELAY_HOST}"
    else
      TARGET="http://$(relay_ip)"
    fi
  fi
fi

echo "Checking ${TARGET}"

fail=0
for path in /_liveness /_readiness; do
  url="${TARGET}${path}"
  if ! curl -fsS --max-time 15 "${url}"; then
    echo
    echo "FAIL ${url}"
    fail=1
  else
    echo
    echo "OK   ${url}"
  fi
done

NIP_URL="${TARGET}/"
if curl -fsS --max-time 15 \
  -H "Accept: application/nostr+json" \
  "${NIP_URL}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("NIP-11 name:", d.get("name") or d.get("software") or list(d)[:6])
print("keys:", ", ".join(sorted(d)[:12]))
'; then
  echo "OK   NIP-11 ${NIP_URL}"
else
  echo "FAIL NIP-11 ${NIP_URL}"
  fail=1
fi

if ssh "${SSH_OPTS[@]}" "$(relay_ssh)" true 2>/dev/null; then
  ssh_run "compose status" "cd ${REMOTE_DIR} && ./run.sh status" || fail=1
else
  echo "SSH skip (set BUZZ_SSH if you want compose status)"
fi

if [[ "${fail}" -ne 0 ]]; then
  die "relay is not healthy"
fi

echo
echo "Relay healthy at ${TARGET}"
echo "Desktop: add ${RELAY_HOST} (wss://${RELAY_HOST} after DNS + TLS)."
