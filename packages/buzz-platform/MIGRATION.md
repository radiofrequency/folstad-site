# BuzzFTW: migrate Fargate/RDS → one EC2 (free relay)

Account `217074483639`, region `us-west-2`, stack `BuzzStack`, zone `buzzftw.com` (`Z03673022RSY2XVF548I0`).

Use IAM user **buzz-deploy**. Scripts default to dry-run / no DNS change / no deletes.

This repo’s CDK never defined `BuzzPlatform` / `LnbitsService`. Those live resources (if present) were created outside the current sources. **CDK deploy adds EC2. Teardown of Fargate/RDS/Redis/LNbits is the script below, not `cdk destroy`.**

Do **not** `cdk destroy BuzzStack` — that removes Cognito, DynamoDB, and the operator API.

## Estimated monthly cost (us-west-2, on-demand, 2026)

| Piece | Before (approx) | After |
|-------|-----------------|-------|
| ECS Fargate `buzz-platform` 1 vCPU / 2 GB | $30–36 | gone |
| ECS Fargate `lnbits` 0.5 / 1 GB | $15–18 | gone |
| ALB + LCU (relay host rules) | $16+ | unused for relay |
| RDS `db.t4g.micro` | $12–15 | gone (Postgres on box) |
| ElastiCache `cache.t4g.micro` | $12–15 | gone (Redis on box) |
| Public IPv4 on ALB ENIs + tasks + RDS | $15–25 | one EIP ~$3.65 |
| **t4g.medium** + 40 GB gp3 + EIP | — | **~$32** |
| t4g.small alternative | — | **~$23** |
| **Rough savings** | **~$100–130** | **~$70–100 / mo** |

t4g instances are launched in **standard** CPU-credit mode (not unlimited) so surplus credits cannot surprise-bill.

Control plane (Cognito, DynamoDB on-demand, API Gateway, Lambda) is a few dollars and is kept.

## 0. Preconditions

```bash
aws sts get-caller-identity   # Account 217074483639
cd infra && npm i
```

Confirm marketing `buzzftw.com` / `www` still hit CloudFront (do not change those records).

## 1. Launch EC2 (no DNS change)

```bash
cd packages/buzz-api && npm i && npm run build
cd ../../infra
npx cdk diff BuzzStack
npx cdk deploy BuzzStack --require-approval never
```

Wait until the instance is `running` and SSM-online (user-data installs Docker and starts compose **without** Caddy). Health is HTTP on the Elastic IP, port 80.

```bash
aws ssm start-session --target "$(
  aws cloudformation describe-stacks --stack-name BuzzStack \
    --query "Stacks[0].Outputs[?OutputKey=='OutRelayInstanceId'].OutputValue" --output text
)"
```

## 2. Copy Postgres (and optional Redis)

```bash
cd packages/buzz-platform/scripts
./migrate-from-rds.sh
```

What it does:

1. Finds RDS (`*platformpostgres*` / `*buzz*`) and the `buzz-relay` instance
2. Creates snapshot `${rds}-pre-ec2-<utc>` and **waits**
3. Opens RDS SG :5432 from the EC2 SG
4. `pg_dump` from the box (same VPC) → `/opt/buzz/migrate/latest.dump`
5. Restores into compose Postgres and restarts the relay

Override if discovery is wrong: `BUZZ_RDS_ID=... DATABASE_URL=postgres://...`

Redis: communities live in Postgres. Skip Redis unless you know you need session/cache continuity (`WITH_REDIS=1` only prints the cluster id). A cold Redis is the default and is safe for a free relay.

## 3. Verify on the Elastic IP (before DNS)

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
| `relay.buzzftw.com` A | Elastic IP |
| `*.buzzftw.com` A | Elastic IP |

**Not changed:** `buzzftw.com`, `www.buzzftw.com`.

Then SSM enables Caddy (`BUZZ_COMPOSE_TLS=true`). Let’s Encrypt is on-demand; `tls-ask` only allows `*.buzzftw.com` except `www`.

```bash
./verify-relay.sh --dns
```

Desktop: join `relay.buzzftw.com` (`wss://relay.buzzftw.com`).

Optional later: `npx cdk deploy -c buzzRelayCutover=true` so the A records are also in CDK (script already wrote them).

## 5. Tear down the expensive path

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

### Manual equivalents (if you prefer the console)

```bash
# scale + delete
aws ecs update-service --cluster buzz --service buzz-platform --desired-count 0
aws ecs update-service --cluster buzz --service lnbits --desired-count 0
aws ecs delete-service --cluster buzz --service buzz-platform --force
aws ecs delete-service --cluster buzz --service lnbits --force

# redis
aws elasticache delete-cache-cluster --cache-cluster-id buzz-redis-buzzstack-001

# rds (snapshot first)
aws rds delete-db-instance \
  --db-instance-identifier <platformpostgres-id> \
  --final-db-snapshot-identifier <id>-final \
  --delete-automated-backups
```

**Do not delete:** Cognito, `buzz-projects`, config bucket, `buzz-runtime` ECR, ECS cluster `buzz`, Folstad project ALB (if still used for `*.folstad.ca`), CloudFront/S3 for buzzftw.com marketing, the Route53 zone, `buzz-relay` EC2, secret `buzz/relay-ec2`.

Idle ENIs and leftover LNbits security groups can be deleted in the console after the services are gone.

## Rollback

1. Point `relay.buzzftw.com` / `*` back at the ALB alias (or restore the previous record set)
2. Restore RDS from `${rds}-pre-ec2-*` or the final snapshot
3. Scale `buzz-platform` back to 1 **only if** you did not delete it yet

## Pinning the Buzz image

Default is `ghcr.io/block/buzz:main` (multi-arch, including arm64). After a good boot, pin in `buzz/relay-ec2`:

```text
BUZZ_IMAGE=ghcr.io/block/buzz:sha-<7>
```

then SSM `cd /opt/buzz && ./run.sh upgrade`.
