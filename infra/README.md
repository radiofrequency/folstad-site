# Buzz auth cutover (`BuzzAuthStack`)

Slim Cognito stack for the Buzz marketplace SPA on **buzzftw.com**.

BuzzStack (Fargate, ALB, RDS, Redis, lnbits, VPC, `FolstadCaZone`) is **DELETE_COMPLETE** as of 2026-09-07. Do not redeploy it. The intended CDK app is `BuzzAuthStack` only.

## What this stack creates

- Cognito user pool (`buzzftw-users`) — email signup, same password policy as the old pool
- Public SPA app client — OAuth authorization-code grant, callbacks from `siteOrigins`
- Hosted UI domain prefix `buzzftw-<account>` (e.g. `buzzftw-217074483639`)

Outputs: `UserPoolId`, `ClientId`, `CognitoDomain`, `Region` (plus `SiteOrigins`).

**Not included:** Fargate, ALB, RDS, ElastiCache, lnbits, VPC/NAT, Elastic IPs, Route53 zones, HTTP API. Folstad marketing DNS (`folstad.ca`) is out of this stack so deploy cannot clobber Folstad Site’s CloudFront cutover.

HTTP API + JWT authorizer is a follow-up. `packages/buzz-api` still expects DynamoDB / ECS / ALB from the retired stack; attaching it here would pull those deps or ship a broken API.

## Deploy (coordinator)

Do **not** run `cdk deploy --all` against the fat stack. Default `cdk list` is `BuzzAuthStack` only.

```bash
cd infra
npm ci
npx cdk synth BuzzAuthStack
npx cdk deploy BuzzAuthStack
```

Optional context overrides:

```bash
# Extra CORS / OAuth origin (e.g. a staging host). Folstad marketing is not required.
npx cdk deploy BuzzAuthStack -c siteOrigins=http://localhost:4321,https://buzzftw.com,https://www.buzzftw.com

# Only if the default prefix is taken globally:
npx cdk deploy BuzzAuthStack -c cognitoDomainPrefix=buzzftw-217074483639
```

Account / region: `217074483639` / `us-west-2` (hard-coded in `bin/buzz.ts`).

To instantiate the retired `BuzzStack` you must set `DEPLOY_FAT_STACK=1` or `-c deployFatStack=true`. Do not do that unless Ryan asks to bring the project-host ALB path back.

## After deploy — SPA env

Copy stack outputs into the marketplace build env (GitHub Actions variables and/or `.env`):

| Output | SPA / Actions variable |
|--------|------------------------|
| `UserPoolId` | `PUBLIC_COGNITO_USER_POOL_ID` |
| `ClientId` | `PUBLIC_COGNITO_CLIENT_ID` |
| `CognitoDomain` | `PUBLIC_COGNITO_DOMAIN` |
| `Region` | `PUBLIC_COGNITO_REGION` (`us-west-2`) |

The previous pool `us-west-2_MIDcSvkwq` / client `5klcs2rg7lmfgjggsl7bo2llkm` is **gone**. Do not reuse those IDs.

Marketplace origins: `https://buzzftw.com` and `https://www.buzzftw.com` (S3 + CloudFront). Local: `http://localhost:4321`.

`PUBLIC_BUZZ_API_URL` is a follow-up (old HTTP API died with BuzzStack). Auth works without it.

## `DOMAIN_SUFFIX` vs Hetzner wildcard

| Host | Where it lives |
|------|----------------|
| `buzzftw.com` / `www.buzzftw.com` | Marketplace SPA (S3 + CloudFront). Cognito CORS / OAuth. |
| `*.buzzftw.com` (communities) and `relay.buzzftw.com` | **Hetzner** (`coconutphuket`). Already in DNS. |
| Project-host ALB (`*.folstad.ca` / Fargate) | Retired unless Ryan brings it back. |

Code `DOMAIN_SUFFIX` is `.buzzftw.com` so community URLs match the live Hetzner wildcard. That constant does **not** mean CDK should create those records.

## Cost

Cognito user pools are in the AWS free tier for typical early traffic (tens of thousands of MAUs). This stack has no always-on compute. **Expected monthly cost: ~$0.**
