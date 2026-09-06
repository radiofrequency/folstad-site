#!/usr/bin/env bash
# First-boot / idempotent start for the free Buzz relay (Hetzner Ubuntu).
# No LNbits. Compose: relay + postgres + redis + minio (+ optional Caddy).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/buzz}"
DOMAIN="${BUZZ_DOMAIN:-relay.buzzftw.com}"
WILDCARD_BASE="${BUZZ_WILDCARD_BASE:-buzzftw.com}"
ACME_EMAIL="${CADDY_ACME_EMAIL:-ops@${WILDCARD_BASE}}"
ENABLE_TLS="${BUZZ_COMPOSE_TLS:-false}"
SEED_JSON="${SEED_JSON:-${DEPLOY_DIR}/seed.json}"

cd "${DEPLOY_DIR}"

seed_from_legacy() {
  local raw="$1"
  python3 -c '
import json, os, sys
legacy = json.loads(sys.argv[1])
if isinstance(legacy, str):
    parsed = {}
    for line in legacy.splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            parsed[k.strip()] = v.strip().strip("\"")
    legacy = parsed

def first(*keys):
    for k in keys:
        v = legacy.get(k)
        if v:
            return str(v)
    return ""

out = {
    "BUZZ_DOMAIN": os.environ["DOMAIN"],
    "BUZZ_WILDCARD_BASE": os.environ["WILDCARD_BASE"],
    "CADDY_ACME_EMAIL": os.environ["ACME_EMAIL"],
    "RELAY_URL": "wss://" + os.environ["DOMAIN"],
    "BUZZ_MEDIA_BASE_URL": "https://" + os.environ["DOMAIN"] + "/media",
    "BUZZ_MEDIA_SERVER_DOMAIN": os.environ["DOMAIN"],
    "BUZZ_CORS_ORIGINS": "https://" + os.environ["DOMAIN"],
    "BUZZ_IMAGE": "ghcr.io/block/buzz:main",
    "BUZZ_REQUIRE_AUTH_TOKEN": "false",
    "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "false",
    "BUZZ_ALLOW_NIP_OA_AUTH": "true",
    "BUZZ_AUTO_MIGRATE": "true",
    "BUZZ_GIT_CONFORMANCE_PROBE": "true",
    "POSTGRES_DB": first("POSTGRES_DB") or "buzz",
    "POSTGRES_USER": first("POSTGRES_USER") or "buzz",
    "POSTGRES_PASSWORD": first("POSTGRES_PASSWORD"),
    "REDIS_PASSWORD": first("REDIS_PASSWORD"),
    "BUZZ_S3_ACCESS_KEY": first("BUZZ_S3_ACCESS_KEY", "S3_ACCESS_KEY"),
    "BUZZ_S3_SECRET_KEY": first("BUZZ_S3_SECRET_KEY", "S3_SECRET_KEY"),
    "BUZZ_S3_BUCKET": first("BUZZ_S3_BUCKET") or "buzz-media",
    "BUZZ_S3_ADDRESSING_STYLE": "path",
    "BUZZ_RELAY_PRIVATE_KEY": first("BUZZ_RELAY_PRIVATE_KEY", "RELAY_PRIVATE_KEY"),
    "BUZZ_GIT_HOOK_HMAC_SECRET": first("BUZZ_GIT_HOOK_HMAC_SECRET"),
    "RELAY_OWNER_PUBKEY": first("RELAY_OWNER_PUBKEY"),
    "BUZZ_HTTP_PORT": "80",
    "CADDY_HTTP_PORT": "80",
    "CADDY_HTTPS_PORT": "443",
    "RUST_LOG": "buzz_relay=info,buzz_db=info,buzz_auth=info,buzz_pubsub=info,tower_http=info",
}
print(json.dumps(out))
' "$raw"
}

generate_secret_json() {
  python3 -c '
import json, os, subprocess

def hx(n=32):
    return subprocess.check_output(["openssl", "rand", "-hex", str(n)], text=True).strip()

def alnum(n=32):
    raw = subprocess.check_output(["openssl", "rand", "-base64", "48"])
    return "".join(c for c in raw.decode() if c.isalnum())[:n]

domain = os.environ["DOMAIN"]
print(json.dumps({
    "BUZZ_DOMAIN": domain,
    "BUZZ_WILDCARD_BASE": os.environ["WILDCARD_BASE"],
    "CADDY_ACME_EMAIL": os.environ["ACME_EMAIL"],
    "RELAY_URL": "wss://" + domain,
    "BUZZ_MEDIA_BASE_URL": "https://" + domain + "/media",
    "BUZZ_MEDIA_SERVER_DOMAIN": domain,
    "BUZZ_CORS_ORIGINS": "https://" + domain,
    "BUZZ_IMAGE": "ghcr.io/block/buzz:main",
    "BUZZ_REQUIRE_AUTH_TOKEN": "false",
    "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "false",
    "BUZZ_ALLOW_NIP_OA_AUTH": "true",
    "BUZZ_AUTO_MIGRATE": "true",
    "BUZZ_GIT_CONFORMANCE_PROBE": "true",
    "POSTGRES_DB": "buzz",
    "POSTGRES_USER": "buzz",
    "POSTGRES_PASSWORD": alnum(32),
    "REDIS_PASSWORD": alnum(32),
    "BUZZ_S3_ACCESS_KEY": alnum(20),
    "BUZZ_S3_SECRET_KEY": alnum(40),
    "BUZZ_S3_BUCKET": "buzz-media",
    "BUZZ_S3_ADDRESSING_STYLE": "path",
    "BUZZ_RELAY_PRIVATE_KEY": hx(32),
    "BUZZ_GIT_HOOK_HMAC_SECRET": hx(32),
    "RELAY_OWNER_PUBKEY": "",
    "BUZZ_HTTP_PORT": "80",
    "CADDY_HTTP_PORT": "80",
    "CADDY_HTTPS_PORT": "443",
    "RUST_LOG": "buzz_relay=info,buzz_db=info,buzz_auth=info,buzz_pubsub=info,tower_http=info",
}))
'
}

fill_missing() {
  python3 -c '
import json, subprocess, sys

def hx(n=32):
    return subprocess.check_output(["openssl", "rand", "-hex", str(n)], text=True).strip()

def alnum(n=32):
    raw = subprocess.check_output(["openssl", "rand", "-base64", "48"])
    return "".join(c for c in raw.decode() if c.isalnum())[:n]

d = json.loads(sys.argv[1])
defaults = {
    "POSTGRES_PASSWORD": lambda: alnum(32),
    "REDIS_PASSWORD": lambda: alnum(32),
    "BUZZ_S3_ACCESS_KEY": lambda: alnum(20),
    "BUZZ_S3_SECRET_KEY": lambda: alnum(40),
    "BUZZ_RELAY_PRIVATE_KEY": lambda: hx(32),
    "BUZZ_GIT_HOOK_HMAC_SECRET": lambda: hx(32),
}
for k, fn in defaults.items():
    if not d.get(k):
        d[k] = fn()
print(json.dumps(d))
' "$1"
}

write_env() {
  python3 -c '
import json, sys
d = json.loads(sys.argv[1])
order = [
    "BUZZ_IMAGE","BUZZ_DOMAIN","BUZZ_WILDCARD_BASE","RELAY_URL",
    "BUZZ_MEDIA_BASE_URL","BUZZ_MEDIA_SERVER_DOMAIN","BUZZ_CORS_ORIGINS",
    "BUZZ_REQUIRE_AUTH_TOKEN","BUZZ_REQUIRE_RELAY_MEMBERSHIP","BUZZ_ALLOW_NIP_OA_AUTH",
    "BUZZ_AUTO_MIGRATE","BUZZ_GIT_CONFORMANCE_PROBE","RUST_LOG",
    "RELAY_OWNER_PUBKEY","BUZZ_RELAY_PRIVATE_KEY","BUZZ_GIT_HOOK_HMAC_SECRET",
    "POSTGRES_DB","POSTGRES_USER","POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "BUZZ_S3_ACCESS_KEY","BUZZ_S3_SECRET_KEY","BUZZ_S3_BUCKET","BUZZ_S3_ADDRESSING_STYLE",
    "BUZZ_HTTP_PORT","CADDY_HTTP_PORT","CADDY_HTTPS_PORT","CADDY_ACME_EMAIL",
]
seen = set()
lines = []
for k in order:
    if k in d:
        lines.append(f"{k}={d[k]}")
        seen.add(k)
for k in sorted(d):
    if k not in seen:
        lines.append(f"{k}={d[k]}")
open(".env","w").write("\n".join(lines) + "\n")
' "$1"
  chmod 600 .env
}

export DOMAIN WILDCARD_BASE ACME_EMAIL

if [[ -f .env ]]; then
  echo "Using existing ${DEPLOY_DIR}/.env"
else
  if [[ -f "${SEED_JSON}" ]]; then
    echo "Seeding .env from ${SEED_JSON} (reuse relay keys)"
    JSON="$(fill_missing "$(seed_from_legacy "$(cat "${SEED_JSON}")")")"
  else
    echo "Generating new .env (no seed.json)"
    JSON="$(generate_secret_json)"
  fi
  write_env "${JSON}"
fi

chmod +x ./run.sh
export BUZZ_COMPOSE_TLS="${ENABLE_TLS}"
./run.sh start
./run.sh status || true
echo "Bootstrap complete. TLS=${ENABLE_TLS} domain=${DOMAIN}"
