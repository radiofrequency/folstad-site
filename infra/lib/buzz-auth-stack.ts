import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { originBase, parseSiteOrigins } from "./site-origins";

/**
 * Slim Buzz auth stack — Cognito only.
 *
 * Safe to deploy into account 217074483639 / us-west-2. Does not create
 * Fargate, ALB, RDS, Redis, lnbits, VPC/NAT, Elastic IPs, or Route53 zones.
 *
 * HTTP API + JWT authorizer is a follow-up: packages/buzz-api still expects
 * DynamoDB, S3, ECS, and ALB env from the retired BuzzStack. Wiring it here
 * would either pull those deps or ship a broken API.
 */
export class BuzzAuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const siteOrigins = parseSiteOrigins(this.node.tryGetContext("siteOrigins"));

    const userPool = new cognito.UserPool(this, "BuzzUserPool", {
      userPoolName: "buzzftw-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("BuzzSpaClient", {
      userPoolClientName: "buzz-spa",
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: siteOrigins.map((o) => `${originBase(o)}/auth/callback`),
        logoutUrls: siteOrigins.map((o) => originBase(o)),
      },
    });

    const domainPrefix =
      this.node.tryGetContext("cognitoDomainPrefix") ?? `buzzftw-${this.account}`;

    userPool.addDomain("BuzzDomain", {
      cognitoDomain: { domainPrefix },
    });

    const cognitoDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Set PUBLIC_COGNITO_USER_POOL_ID to this value",
    });
    new cdk.CfnOutput(this, "ClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Set PUBLIC_COGNITO_CLIENT_ID to this value",
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: cognitoDomain,
      description: "Set PUBLIC_COGNITO_DOMAIN to this value (no https://)",
    });
    new cdk.CfnOutput(this, "Region", {
      value: this.region,
      description: "Set PUBLIC_COGNITO_REGION to this value",
    });
    new cdk.CfnOutput(this, "SiteOrigins", {
      value: siteOrigins.join(","),
      description: "OAuth callback/logout + CORS allow-list (SPA marketplace origins)",
    });
  }
}
