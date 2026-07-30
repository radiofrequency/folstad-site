#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BuzzStack } from "../lib/buzz-stack";

const app = new cdk.App();

new BuzzStack(app, "BuzzStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-west-2",
  },
  description: "Buzz control plane: Cognito, API, DynamoDB (+ ECS hooks)",
});
