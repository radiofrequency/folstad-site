# Buzz packages

| Package | Role |
|---------|------|
| `buzz-shared` | API + Project TypeScript types |
| `buzz-api` | Lambda handlers (JWT auth, DynamoDB, ECS lifecycle) |
| `buzz-runtime` | Fargate container: `/` landing + `/health` |
| `buzz-platform` | Free BuzzFTW relay on Hetzner (compose, migrate, teardown). No LNbits |
| `../../infra` | CDK: **`BuzzAuthStack`** (Cognito only). Fat `BuzzStack` is retired. |

## Local site

```bash
npm run dev
```

Open `/signup` → verify email → `/login` → `/buzz` → `/dashboard`.

Auth requires `PUBLIC_COGNITO_USER_POOL_ID` and `PUBLIC_COGNITO_CLIENT_ID` from `BuzzAuthStack` outputs. Do not use the deleted pool `us-west-2_MIDcSvkwq`.

## Deploy auth (slim stack)

```bash
cd infra && npm i && npx cdk deploy BuzzAuthStack
```

Then set SPA / Actions vars from the outputs. Full notes: [`../../infra/README.md`](../../infra/README.md).

HTTP API + `buzz-api` Lambda is a follow-up (it still expects DynamoDB/ECS/ALB from the retired stack).

Public relay (`relay.buzzftw.com`) is a Hetzner compose stack. Runbook: [`../buzz-platform/MIGRATION.md`](../buzz-platform/MIGRATION.md).
