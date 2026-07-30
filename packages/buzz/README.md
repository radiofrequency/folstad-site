# Buzz packages

| Package | Role |
|---------|------|
| `buzz-shared` | API + Project TypeScript types |
| `buzz-api` | Lambda handlers (JWT via Cognito, DynamoDB, ECS lifecycle) |
| `buzz-runtime` | Fargate container: `/` landing + `/health` |
| `../../infra` | CDK: Cognito User Pool, HTTP API, DDB, VPC, ECS cluster, ALB, ECR |

## Local UI (no AWS)

1. `npm run dev` from repo root  
2. Open `/signup` → verify with code **123456** → `/login`  
3. `/buzz` launch → `/dashboard` stop/restart/logs  

Mock mode is automatic when `PUBLIC_COGNITO_*` and `PUBLIC_BUZZ_API_URL` are unset.

## Deploy control plane

```bash
# Build lambda bundle
cd packages/buzz-api && npm i && npm run build

# Deploy stack (requires AWS credentials + CDK bootstrap)
cd ../../infra && npm i && npx cdk deploy

# Copy outputs into site .env
PUBLIC_BUZZ_API_URL=...
PUBLIC_COGNITO_USER_POOL_ID=...
PUBLIC_COGNITO_CLIENT_ID=...
PUBLIC_COGNITO_REGION=...
```

## Auth

AWS Cognito User Pool: email sign-up, **email verification required**, SRP sign-in.  
API Gateway JWT authorizer validates access tokens. Projects scoped by `cognito:sub`.
