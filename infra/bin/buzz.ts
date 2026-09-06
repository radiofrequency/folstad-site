#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BuzzStack } from "../lib/buzz-stack";

const app = new cdk.App();

new BuzzStack(app, "BuzzStack", {
  env: {
    // Live BuzzFTW account/region. Do not let a local AWS default (often us-east-1) redirect the stack.
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "217074483639",
    region: "us-west-2",
  },
  description: "Buzz control plane: Cognito, API, DynamoDB (+ ECS hooks)",
});
