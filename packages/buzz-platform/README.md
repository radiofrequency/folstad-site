# Buzz platform (free relay on Hetzner)

Single-box BuzzFTW: **relay + Postgres + Redis + MinIO + Caddy**. No Lightning, no LNbits.

Auth is the slim CDK stack **`BuzzAuthStack`** (Cognito only) in `infra/`. **`cdk deploy` does not create a relay** and must not redeploy the retired fat `BuzzStack`. The public `relay.buzzftw.com` path is a Hetzner VPS.

Community hosts (`*.buzzftw.com`) already hit this box. Code `DOMAIN_SUFFIX` is `.buzzftw.com` to match that wildcard — it does not mean CDK should create those records. Marketplace apex/www stay on S3 + CloudFront; Cognito CORS/OAuth origins are `https://buzzftw.com` and `https://www.buzzftw.com`. Cutover: [`../../infra/README.md`](../../infra/README.md).

## Layout

| Path | Role |
|------|------|
| `deploy/` | Upstream `block/buzz` compose (pinned in `deploy/UPSTREAM`) plus bootstrap / Caddy overlays |
| `scripts/` | provision → migrate → verify → DNS cutover → teardown |
| `MIGRATION.md` | Ordered runbook and estimated savings |

## Deploy the box

Need SSH to the VPS. `hcloud` is optional (only if you are creating a new server).

```bash
# existing Ubuntu box:
export HETZNER_IP=x.x.x.x
# or copy scripts/.relay.env.example → scripts/.relay.env

cd packages/buzz-platform/scripts
./provision-hetzner.sh
```

Default new-server size is **CX22** (~4 GB). Override with `HCLOUD_TYPE=cx23` (or any Cloud type) if you create via `hcloud`.

## After provision

Follow **[MIGRATION.md](./MIGRATION.md)**. Short version:

1. `scripts/migrate-from-rds.sh` — snapshot RDS, dump on the laptop, scp, restore
2. `scripts/verify-relay.sh --ip` — `/_liveness`, `/_readiness`, NIP-11 on the Hetzner IP
3. `scripts/cutover-dns.sh` — `relay.buzzftw.com` + `*.buzzftw.com` → Hetzner, then Caddy/HTTPS
4. Desktop joins `relay.buzzftw.com`
5. `scripts/teardown-legacy.sh --dry-run` then `--execute --i-verified-relay-healthy`

Apex `buzzftw.com` / `www` stay on the existing CloudFront/S3 marketing site.

## Compose on the box

`/opt/buzz` is the upstream bundle. `BUZZ_COMPOSE_TLS=true ./run.sh start` adds Caddy.

Free-relay defaults (written by `deploy/bootstrap.sh`):

- `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false` (Desktop can join without NIP-43 / LNbits)
- `BUZZ_REQUIRE_AUTH_TOKEN=false`
- `.env` is seeded from AWS secret `buzz/platform` when `provision-hetzner.sh` can read it, so the relay key does not rotate
