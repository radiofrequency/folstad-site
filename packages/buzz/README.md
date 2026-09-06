# Buzz packages

| Package | Role |
|---------|------|
| `buzz-shared` | API + Project TypeScript types |
| `buzz-api` | Lambda handlers (JWT auth, DynamoDB, ECS lifecycle) |
| `buzz-runtime` | Fargate container: `/` landing + `/health` |
| `buzz-platform` | Free BuzzFTW relay on Hetzner (compose, migrate, teardown). No LNbits |
| `../../infra` | CDK: Folstad control plane only (no relay EC2) |

## Local site

```bash
npm run dev
```

Open `/signup` → verify email → `/login` → `/buzz` → `/dashboard`.

Auth and API always talk to the live control plane (public SPA client config in `src/lib`).

## Deploy control plane

```bash
cd packages/buzz-api && npm i && npm run build
cd ../../infra && npm i && npx cdk deploy
```

Public relay (`relay.buzzftw.com`) is a Hetzner compose stack. Runbook: [`../buzz-platform/MIGRATION.md`](../buzz-platform/MIGRATION.md).
