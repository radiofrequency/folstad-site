# Buzz packages

| Package | Role |
|---------|------|
| `buzz-shared` | API + Project TypeScript types |
| `buzz-api` | Lambda handlers (JWT auth, DynamoDB, ECS lifecycle) |
| `buzz-runtime` | Fargate container: `/` landing + `/health` |
| `../../infra` | CDK: user pool, HTTP API, DDB, VPC, ECS cluster, ALB, ECR, Route53 |

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
