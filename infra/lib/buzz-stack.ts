import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Construct } from "constructs";
import * as path from "node:path";

export class BuzzStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const siteOrigins = (
      this.node.tryGetContext("siteOrigins") ??
      "http://localhost:4321,https://folstad.ca,https://www.folstad.ca"
    ).split(",");

    // ——— Cognito ———
    const userPool = new cognito.UserPool(this, "BuzzUserPool", {
      userPoolName: "buzz-users",
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
        callbackUrls: siteOrigins.map((o: string) => `${o.replace(/\/$/, "")}/auth/callback`),
        logoutUrls: siteOrigins.map((o: string) => o.replace(/\/$/, "")),
      },
    });

    const domainPrefix =
      this.node.tryGetContext("cognitoDomainPrefix") ?? `buzz-folstad-${this.account}`;

    userPool.addDomain("BuzzDomain", {
      cognitoDomain: { domainPrefix },
    });

    // ——— Data ———
    const projectsTable = new dynamodb.Table(this, "Projects", {
      tableName: "buzz-projects",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    projectsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    projectsTable.addGlobalSecondaryIndex({
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const configBucket = new s3.Bucket(this, "ConfigBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const runtimeRepo = new ecr.Repository(this, "RuntimeRepo", {
      repositoryName: "buzz-runtime",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // ——— Network / ECS ———
    const vpc = new ec2.Vpc(this, "BuzzVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, "BuzzCluster", {
      clusterName: "buzz",
      vpc,
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const taskSg = new ec2.SecurityGroup(this, "TaskSg", { vpc, allowAllOutbound: true });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(8080), "ALB to tasks");

    const alb = new elbv2.ApplicationLoadBalancer(this, "BuzzAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // HTTP listener — per-project host/path rules attached by provisioner
    const httpListener = alb.addListener("Http", {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Unknown Buzz host",
      }),
    });

    // ——— Route53: folstad.ca (cut over NS from GoDaddy → stack outputs) ———
    // Preserves marketing site on GitHub Pages; wildcard sends project hosts to the ALB.
    // HTTPS/ACM is a follow-up once these nameservers are live at the registrar.
    const zone = new route53.PublicHostedZone(this, "FolstadCaZone", {
      zoneName: "folstad.ca",
      comment: "Buzz + marketing site (GitHub Pages apex/www)",
    });

    // Apex → GitHub Pages (A records)
    new route53.ARecord(this, "ApexGithubPages", {
      zone,
      // zone apex
      target: route53.RecordTarget.fromIpAddresses(
        "185.199.108.153",
        "185.199.109.153",
        "185.199.110.153",
        "185.199.111.153",
      ),
      ttl: cdk.Duration.minutes(5),
    });

    // www → GitHub Pages
    new route53.CnameRecord(this, "WwwGithubPages", {
      zone,
      recordName: "www",
      domainName: "radiofrequency.github.io",
      ttl: cdk.Duration.minutes(5),
    });

    // *.folstad.ca → Buzz ALB (project subdomains via host-header rules)
    new route53.ARecord(this, "WildcardToAlb", {
      zone,
      recordName: "*",
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    // ——— ECS task roles (used by provisioner when registering task defs) ———
    const taskExecutionRole = new iam.Role(this, "EcsTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    // Allow awslogs-create-group
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup"],
        resources: ["*"],
      }),
    );

    const taskRole = new iam.Role(this, "EcsTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    configBucket.grantRead(taskRole);

    // ——— Shared Lambda env / IAM for API + provisioner ———
    const lambdaEnv: Record<string, string> = {
      PROJECTS_TABLE: projectsTable.tableName,
      CONFIG_BUCKET: configBucket.bucketName,
      ECS_CLUSTER: cluster.clusterName,
      CORS_ORIGIN: siteOrigins.join(","),
      RUNTIME_IMAGE: `${runtimeRepo.repositoryUri}:latest`,
      ALB_LISTENER_ARN: httpListener.listenerArn,
      ALB_DNS_NAME: alb.loadBalancerDnsName,
      // After GoDaddy NS → Route53, project URLs use https? still http until ACM
      CUSTOM_DOMAIN_ENABLED: "true",
      DOMAIN_SUFFIX: ".folstad.ca",
      VPC_ID: vpc.vpcId,
      TASK_SUBNETS: vpc.publicSubnets.map((s) => s.subnetId).join(","),
      TASK_SECURITY_GROUP: taskSg.securityGroupId,
      ECS_EXECUTION_ROLE_ARN: taskExecutionRole.roleArn,
      ECS_TASK_ROLE_ARN: taskRole.roleArn,
    };

    const controlPlanePolicy = new iam.PolicyStatement({
      actions: [
        "ecs:CreateService",
        "ecs:UpdateService",
        "ecs:DescribeServices",
        "ecs:DeleteService",
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeTaskDefinition",
        "ecs:DeregisterTaskDefinition",
        "ecs:ListTasks",
        "ecs:DescribeTasks",
        "ecs:TagResource",
        "elasticloadbalancing:CreateTargetGroup",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:CreateRule",
        "elasticloadbalancing:DeleteRule",
        "elasticloadbalancing:ModifyRule",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:AddTags",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:DescribeLogStreams",
        "logs:CreateLogGroup",
        "logs:PutRetentionPolicy",
        "logs:TagLogGroup",
        "iam:PassRole",
      ],
      resources: ["*"],
    });

    const apiLogGroup = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const codeAsset = lambda.Code.fromAsset(
      path.join(__dirname, "../../packages/buzz-api/dist"),
    );

    const provisionFn = new lambda.Function(this, "BuzzProvision", {
      functionName: "buzz-provision",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "provision.handler",
      code: codeAsset,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    projectsTable.grantReadWriteData(provisionFn);
    configBucket.grantReadWrite(provisionFn);
    provisionFn.addToRolePolicy(controlPlanePolicy);
    // PassRole only for our ECS roles
    provisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [taskExecutionRole.roleArn, taskRole.roleArn],
      }),
    );

    const apiFn = new lambda.Function(this, "BuzzApi", {
      functionName: "buzz-api",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "router.handler",
      code: codeAsset,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...lambdaEnv,
        PROVISION_FUNCTION_NAME: provisionFn.functionName,
      },
      logGroup: apiLogGroup,
    });
    projectsTable.grantReadWriteData(apiFn);
    configBucket.grantReadWrite(apiFn);
    apiFn.addToRolePolicy(controlPlanePolicy);
    provisionFn.grantInvoke(apiFn);

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwt",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    );

    const httpApi = new apigwv2.HttpApi(this, "BuzzHttpApi", {
      apiName: "buzz-api",
      corsPreflight: {
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: siteOrigins,
        maxAge: cdk.Duration.days(1),
      },
    });

    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", apiFn);

    const routes: Array<{ path: string; methods: apigwv2.HttpMethod[] }> = [
      { path: "/v1/projects", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      { path: "/v1/projects/{id}", methods: [apigwv2.HttpMethod.GET] },
      { path: "/v1/projects/{id}/health", methods: [apigwv2.HttpMethod.GET] },
      { path: "/v1/projects/{id}/stop", methods: [apigwv2.HttpMethod.POST] },
      { path: "/v1/projects/{id}/restart", methods: [apigwv2.HttpMethod.POST] },
      { path: "/v1/projects/{id}/logs", methods: [apigwv2.HttpMethod.GET] },
    ];

    for (const r of routes) {
      httpApi.addRoutes({
        path: r.path,
        methods: r.methods,
        integration,
        authorizer: jwtAuthorizer,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "OutUserPoolId", {
      value: userPool.userPoolId,
      exportName: "BuzzUserPoolId",
    });
    new cdk.CfnOutput(this, "OutUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      exportName: "BuzzUserPoolClientId",
    });
    new cdk.CfnOutput(this, "OutCognitoDomain", {
      value: `${domainPrefix}.auth.${this.region}.amazoncognito.com`,
      exportName: "BuzzCognitoDomain",
    });
    new cdk.CfnOutput(this, "OutApiUrl", {
      value: `${httpApi.apiEndpoint}/v1`,
      exportName: "BuzzApiUrl",
    });
    new cdk.CfnOutput(this, "OutRegion", {
      value: this.region,
      exportName: "BuzzRegion",
    });
    new cdk.CfnOutput(this, "OutProjectsTable", {
      value: projectsTable.tableName,
      exportName: "BuzzProjectsTable",
    });
    new cdk.CfnOutput(this, "OutConfigBucketName", {
      value: configBucket.bucketName,
      exportName: "BuzzConfigBucket",
    });
    new cdk.CfnOutput(this, "OutEcrRepoUri", {
      value: runtimeRepo.repositoryUri,
      exportName: "BuzzEcrRepoUri",
    });
    new cdk.CfnOutput(this, "OutEcsClusterName", {
      value: cluster.clusterName,
      exportName: "BuzzEcsClusterName",
    });
    new cdk.CfnOutput(this, "OutAlbDnsName", {
      value: alb.loadBalancerDnsName,
      exportName: "BuzzAlbDnsName",
    });
    new cdk.CfnOutput(this, "OutHttpListenerArn", {
      value: httpListener.listenerArn,
      exportName: "BuzzHttpListenerArn",
    });
    new cdk.CfnOutput(this, "OutProvisionFunction", {
      value: provisionFn.functionName,
      exportName: "BuzzProvisionFunction",
    });
    new cdk.CfnOutput(this, "OutHostedZoneId", {
      value: zone.hostedZoneId,
      exportName: "BuzzHostedZoneId",
    });
    new cdk.CfnOutput(this, "OutNameServers", {
      value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
      exportName: "BuzzNameServers",
      description: "Set these NS records at GoDaddy for folstad.ca",
    });
  }
}
