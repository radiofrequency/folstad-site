# Buzz platform (free relay on EC2)

Single-box BuzzFTW: **relay + Postgres + Redis + MinIO + Caddy**. No Lightning, no LNbits.

The Folstad control plane (Cognito, DynamoDB `buzz-projects`, HTTP API) stays in `infra/lib/buzz-stack.ts`. This package is only the public `relay.buzzftw.com` path.

## Layout

| Path | Role |
|------|------|
| `deploy/` | Upstream `block/buzz` compose (pinned in `deploy/UPSTREAM`) plus bootstrap / Caddy overlays |
| `scripts/` | Ryan-facing migrate → verify → DNS cutover → teardown |
| `MIGRATION.md` | Ordered runbook and estimated savings |

## Deploy the box

From a machine with `buzz-deploy` creds (account `217074483639`, `us-west-2`):

```bash
cd packages/buzz-api && npm i && npm run build
cd ../../infra && npm i
npx cdk deploy BuzzStack --require-approval never
```

That creates a **t4g.medium** Amazon Linux 2023 instance (`buzz-relay`), Elastic IP, and SSM role. It does **not** move DNS. Context flags in `infra/cdk.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `buzzRelayEnabled` | `true` | Create the EC2 path |
| `buzzRelayInstanceType` | `t4g.medium` | Use `t4g.small` to save more (~2 GB is tight) |
| `buzzRelayCutover` | `false` | If `true`, CDK upserts `relay` + `*` A records. Prefer `scripts/cutover-dns.sh` instead |

SSH is closed. Use Session Manager:

```bash
aws ssm start-session --target "$(aws cloudformation describe-stacks --stack-name BuzzStack --query "Stacks[0].Outputs[?OutputKey=='OutRelayInstanceId'].OutputValue" --output text)"
```

## After deploy

Follow **[MIGRATION.md](./MIGRATION.md)**. Short version:

1. `scripts/migrate-from-rds.sh` — snapshot RDS, dump, restore into compose
2. `scripts/verify-relay.sh --ip` — `/_liveness`, `/_readiness`, NIP-11 on the EIP
3. `scripts/cutover-dns.sh` — `relay.buzzftw.com` + `*.buzzftw.com` → EIP, then Caddy/HTTPS
4. Desktop joins `relay.buzzftw.com`
5. `scripts/teardown-legacy.sh --dry-run` then `--execute --i-verified-relay-healthy`

Apex `buzzftw.com` / `www` stay on the existing CloudFront/S3 marketing site.

## Compose on the box

`/opt/buzz` is the upstream bundle. `BUZZ_COMPOSE_TLS=true ./run.sh start` adds Caddy.

Free-relay defaults (written by `deploy/bootstrap.sh`):

- `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false` (Desktop can join without NIP-43 / LNbits)
- `BUZZ_REQUIRE_AUTH_TOKEN=false`
- Secrets in Secrets Manager `buzz/relay-ec2`, seeded from `buzz/platform` when present so the relay key does not rotate
