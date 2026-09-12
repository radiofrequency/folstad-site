#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BuzzAuthStack } from "../lib/buzz-auth-stack";
import { BuzzStack } from "../lib/buzz-stack";

const app = new cdk.App();

const env = {
  // Live BuzzFTW account/region. Do not let a local AWS default (often us-east-1) redirect the stack.
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "217074483639",
  region: "us-west-2",
};

// Intended path. Cognito only — no Fargate/ALB/RDS/Redis/VPC.
new BuzzAuthStack(app, "BuzzAuthStack", {
  env,
  description: "Buzz auth: Cognito user pool + hosted UI domain (no compute)",
});

// Retired full platform (DELETE_COMPLETE 2026-09-07). Instantiating it here
// would make `cdk deploy --all` resurrect VPC/ALB/ECS spend and FolstadCaZone.
// Opt in only: DEPLOY_FAT_STACK=1 or -c deployFatStack=true
const deployFat =
  process.env.DEPLOY_FAT_STACK === "1" || app.node.tryGetContext("deployFatStack") === true;

if (deployFat) {
  new BuzzStack(app, "BuzzStack", {
    env,
    description:
      "RETIRED full Buzz platform — do not deploy unless Ryan explicitly requests it",
  });
}
