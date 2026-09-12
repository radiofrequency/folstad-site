# BuzzFTW: migrate Fargate/RDS → one Hetzner VPS (free relay)

Repo: [`radiofrequency/buzzftw`](https://github.com/radiofrequency/buzzftw). Product: https://buzzftw.com — relay: https://relay.buzzftw.com.

Account `217074483639`, region `us-west-2`, zone `buzzftw.com` (`Z03673022RSY2XVF548I0`).

`BuzzStack` is **DELETE_COMPLETE** (2026-09-07), including Cognito pool `us-west-2_MIDcSvkwq`. New auth is **`BuzzAuthStack`** — see [`../../infra/README.md`](../../infra/README.md). Do not recreate Fargate / ALB / RDS / ElastiCache / lnbits.

Laptop: IAM **buzz-deploy** (for RDS snapshot / Route53 / teardown) plus SSH to the VPS. Scripts default to dry-run / no DNS change / no deletes.

This repo’s CDK never defined `BuzzPlatform` / `LnbitsService`. Those live resources (if present) were created outside the current sources. **`cdk deploy` does not create a relay.** Tear down Fargate/RDS/Redis/LNbits with the script below, not `cdk destroy`.

Do **not** `cdk deploy BuzzStack` — that stack is retired and would resurrect compute spend plus a `folstad.ca` GitHub Pages zone.

## Estimated monthly cost

| Piece | Before (approx) | After |
|-------|-----------------|-------|
| ECS Fargate `buzz-platform` 1 vCPU / 2 GB | $30–36 | gone |
| ECS Fargate `lnbits` 0.5 / 1 GB | $15–18 | gone |
| ALB + LCU (relay host rules) | $16+ | unused for relay |
| RDS `db.t4g.micro` | $12–15 | gone (Postgres on box) |
| ElastiCache `cache.t4g.micro` | $12–15 | gone (Redis on box) |
| Public IPv4 on ALB ENIs + tasks + RDS | $15–25 | gone |
| **Hetzner CX22** (2 vCPU / 4 GB / 40 GB) | — | **~$5–6 (€4–5)** |
| CX23-class if you want more headroom | — | still under ~$10 |
| **Rough savings** | **~$100–130** | **~$95–125 / mo** |

Control plane (Cognito, DynamoDB on-demand, API Gateway, Lambda) stays on AWS and is a few dollars.

## 0. Preconditions

```bash
aws sts get-caller-identity   # Account 217074483639
# SSH to the VPS works (or hcloud is logged in to create one)
```

Confirm marketing `buzzftw.com` / `www` still hit CloudFront (do not change those records).

Optional env file: copy `scripts/.relay.env.example` → `scripts/.relay.env`.

## 1. Provision Hetzner (no DNS change)

**Existing Ubuntu server:**

```bash
export HETZNER_IP=x.x.x.x
export BUZZ_SSH=root@x.x.x.x   # if not root@IP
cd packages/buzz-platform/scripts
./provision-hetzner.sh
```

**New Cloud server** (`hcloud` CLI):

```bash
export HCLOUD_SSH_KEY=your-key-name
export HCLOUD_LOCATION=ash          # or hel1 / nbg1 / fsn1
export HCLOUD_TYPE=cx22             # default; cx23-class if you prefer
./provision-hetzner.sh
```

That installs Docker, rsyncs `deploy/` to `/opt/buzz`, and starts compose **without** Caddy. Health is HTTP on the VPS IP, port 80. Restrict the Hetzner firewall to **22 / 80 / 443**.

## 2. Copy Postgres (and optional Redis)

```bash
./migrate-from-rds.sh
```

What it does:

1. Finds RDS (`*platformpostgres*` / `*buzz*`)
2. Creates snapshot `${rds}-pre-hetzner-<utc>` and **waits**
3. Opens RDS :5432 to your current public IP (and enables public access if needed)
4. `pg_dump` on the laptop → scp → `/opt/buzz/migrate/latest.dump`
5. Restores into compose Postgres over SSH
6. Revokes the temporary SG hole

Override if discovery is wrong: `BUZZ_RDS_ID=... DATABASE_URL=postgres://...`

Redis: communities live in Postgres. A cold Redis is the default and is safe for a free relay.

## 3. Verify on the Hetzner IP (before DNS)

```bash
./verify-relay.sh --ip
```

Expect HTTP 200 on `/_liveness` and `/_readiness`, plus a NIP-11 JSON document.

## 4. DNS cutover + HTTPS

```bash
./cutover-dns.sh
```

Upserts (TTL 60):

| Record | Value |
|--------|--------|
| `relay.buzzftw.com` A | Hetzner IPv4 |
| `*.buzzftw.com` A | Hetzner IPv4 |

**Not changed:** `buzzftw.com`, `www.buzzftw.com`.

Then SSH enables Caddy (`BUZZ_COMPOSE_TLS=true`). Let’s Encrypt is on-demand; `tls-ask` only allows `*.buzzftw.com` except `www`.

```bash
./verify-relay.sh --dns
```

Desktop: join `relay.buzzftw.com` (`wss://relay.buzzftw.com`).

## 5. Tear down the expensive AWS path

Always dry-run first:

```bash
./teardown-legacy.sh --dry-run
```

After Desktop works:

```bash
./teardown-legacy.sh --execute --i-verified-relay-healthy
```

Order the script uses:

1. Re-run `verify-relay.sh --dns` (abort if unhealthy)
2. Scale ECS `buzz-platform` and `lnbits` to 0, then `delete-service --force`
3. Delete ElastiCache `buzz-redis-*`
4. Delete RDS with a **final snapshot**
5. Delete LNbits EFS + mount targets
6. Delete ALB listener rules whose host headers mention `buzzftw.com` or `lnbits`

### Manual equivalents

```bash
aws ecs update-service --cluster buzz --service buzz-platform --desired-count 0
aws ecs update-service --cluster buzz --service lnbits --desired-count 0
aws ecs delete-service --cluster buzz --service buzz-platform --force
aws ecs delete-service --cluster buzz --service lnbits --force

aws elasticache delete-cache-cluster --cache-cluster-id buzz-redis-buzzstack-001

aws rds delete-db-instance \
  --db-instance-identifier <platformpostgres-id> \
  --final-db-snapshot-identifier <id>-final \
  --delete-automated-backups
```

**Do not delete:** CloudFront/S3 for buzzftw.com marketplace, the `buzzftw.com` Route53 zone, the Hetzner VPS. Do not touch `folstad.ca` DNS (Folstad Site CloudFront). New Cognito lives in `BuzzAuthStack` after the coordinator deploys it.

## Rollback

1. Point `relay.buzzftw.com` / `*` back at the ALB alias (or restore the previous record set)
2. Restore RDS from `${rds}-pre-hetzner-*` or the final snapshot
3. Scale `buzz-platform` back to 1 **only if** you did not delete it yet

## Pinning the Buzz image

Default is `ghcr.io/block/buzz:main`. After a good boot, pin in `/opt/buzz/.env`:

```text
BUZZ_IMAGE=ghcr.io/block/buzz:sha-<7>
```

then SSH `cd /opt/buzz && ./run.sh upgrade`.
