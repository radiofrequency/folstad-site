/**
 * AWS helpers for provisioning a single Buzz project on Fargate + shared ALB.
 */
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  waitUntilServicesStable,
} from "@aws-sdk/client-ecs";
import {
  ElasticLoadBalancingV2Client,
  CreateTargetGroupCommand,
  CreateRuleCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupAttributesCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Project } from "@folstad/buzz-shared";

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";

const ecs = new ECSClient({ region });
const elbv2 = new ElasticLoadBalancingV2Client({ region });
const s3 = new S3Client({ region });
const cw = new CloudWatchLogsClient({ region });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function shortId(projectId: string): string {
  return projectId.replace(/-/g, "").slice(0, 8);
}

function serviceName(projectId: string): string {
  return `buzz-${shortId(projectId)}`;
}

/** Compact config for container env (landing page). */
function runtimeConfigEnv(project: Project): string {
  return JSON.stringify({
    projectId: project.projectId,
    projectName: project.projectName,
    domain: project.domain,
    industryLabel: project.industryLabel,
    bots: project.bots.map((b) => ({ name: b.name, role: b.role })),
  });
}

export type ProvisionResult = {
  ecsCluster: string;
  ecsServiceName: string;
  taskDefinitionArn: string;
  targetGroupArn: string;
  listenerRuleArn: string;
  logGroupName: string;
  configS3Key: string;
  /** Working URL on the shared ALB (path-based, no DNS required). */
  url: string;
};

export async function provisionProject(project: Project): Promise<ProvisionResult> {
  const cluster = requireEnv("ECS_CLUSTER");
  const image = requireEnv("RUNTIME_IMAGE");
  const listenerArn = requireEnv("ALB_LISTENER_ARN");
  const vpcId = requireEnv("VPC_ID");
  const subnets = requireEnv("TASK_SUBNETS").split(",").map((s) => s.trim()).filter(Boolean);
  const securityGroup = requireEnv("TASK_SECURITY_GROUP");
  const executionRoleArn = requireEnv("ECS_EXECUTION_ROLE_ARN");
  const taskRoleArn = requireEnv("ECS_TASK_ROLE_ARN");
  const configBucket = requireEnv("CONFIG_BUCKET");
  const albDns = requireEnv("ALB_DNS_NAME");

  if (subnets.length < 1) throw new Error("TASK_SUBNETS is empty");

  const sid = shortId(project.projectId);
  const svcName = serviceName(project.projectId);
  const logGroupName = `/buzz/${project.projectId}`;
  const configS3Key = `configs/${project.projectId}.json`;
  const tgName = `buzz-${sid}`; // max 32

  // 1) Full config to S3
  await s3.send(
    new PutObjectCommand({
      Bucket: configBucket,
      Key: configS3Key,
      ContentType: "application/json",
      Body: JSON.stringify(project, null, 2),
    }),
  );

  // 2) Log group (awslogs-create-group also works; create explicitly for clarity)
  try {
    await cw.send(
      new CreateLogGroupCommand({
        logGroupName,
        tags: {
          Project: "buzz",
          ProjectId: project.projectId,
        },
      }),
    );
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "ResourceAlreadyExistsException") throw err;
  }

  // 3) Target group (reuse if re-provisioning)
  let targetGroupArn = await findTargetGroupArn(tgName);
  if (!targetGroupArn) {
    const tgRes = await elbv2.send(
      new CreateTargetGroupCommand({
        Name: tgName,
        Protocol: "HTTP",
        Port: 8080,
        VpcId: vpcId,
        TargetType: "ip",
        HealthCheckEnabled: true,
        HealthCheckPath: "/health",
        HealthCheckProtocol: "HTTP",
        HealthCheckIntervalSeconds: 15,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: "200" },
        Tags: [
          { Key: "Project", Value: "buzz" },
          { Key: "ProjectId", Value: project.projectId },
        ],
      }),
    );
    targetGroupArn = tgRes.TargetGroups?.[0]?.TargetGroupArn;
  }
  if (!targetGroupArn) throw new Error("CreateTargetGroup returned no ARN");

  await elbv2.send(
    new ModifyTargetGroupAttributesCommand({
      TargetGroupArn: targetGroupArn,
      Attributes: [{ Key: "deregistration_delay.timeout_seconds", Value: "30" }],
    }),
  );

  // 4) Listener path rule (skip if path already routed)
  const hostHeader = project.domain;
  let listenerRuleArn =
    (await findRuleArnForPath(listenerArn, `/p/${project.subdomain}`)) ?? "";

  if (!listenerRuleArn) {
    const priority = await nextListenerPriority(listenerArn);
    const ruleRes = await elbv2.send(
      new CreateRuleCommand({
        ListenerArn: listenerArn,
        Priority: priority,
        Conditions: [
          {
            Field: "path-pattern",
            PathPatternConfig: {
              Values: [`/p/${project.subdomain}`, `/p/${project.subdomain}/*`],
            },
          },
        ],
        Actions: [
          {
            Type: "forward",
            TargetGroupArn: targetGroupArn,
          },
        ],
        Tags: [
          { Key: "Project", Value: "buzz" },
          { Key: "ProjectId", Value: project.projectId },
        ],
      }),
    );
    listenerRuleArn = ruleRes.Rules?.[0]?.RuleArn ?? "";
  }
  if (!listenerRuleArn) throw new Error("CreateRule returned no ARN");

  try {
    const hasHost = await findRuleArnForHost(listenerArn, hostHeader);
    if (!hasHost) {
      const hostPriority = await nextListenerPriority(listenerArn);
      await elbv2.send(
        new CreateRuleCommand({
          ListenerArn: listenerArn,
          Priority: hostPriority,
          Conditions: [
            {
              Field: "host-header",
              HostHeaderConfig: { Values: [hostHeader] },
            },
          ],
          Actions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
          Tags: [
            { Key: "Project", Value: "buzz" },
            { Key: "ProjectId", Value: project.projectId },
            { Key: "Rule", Value: "host" },
          ],
        }),
      );
    }
  } catch (err) {
    console.warn("host-header rule skipped", err);
  }

  // 5) Task definition
  const reg = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: `buzz-${sid}`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "256",
      memory: "512",
      executionRoleArn,
      taskRoleArn,
      containerDefinitions: [
        {
          name: "buzz",
          image,
          essential: true,
          portMappings: [{ containerPort: 8080, protocol: "tcp" }],
          environment: [
            { name: "PORT", value: "8080" },
            { name: "PROJECT_ID", value: project.projectId },
            { name: "PROJECT_NAME", value: project.projectName },
            { name: "PROJECT_DOMAIN", value: project.domain },
            { name: "PROJECT_CONFIG_JSON", value: runtimeConfigEnv(project) },
            { name: "CONFIG_S3_BUCKET", value: configBucket },
            { name: "CONFIG_S3_KEY", value: configS3Key },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": region,
              "awslogs-stream-prefix": "ecs",
              "awslogs-create-group": "true",
            },
          },
        },
      ],
      tags: [
        { key: "Project", value: "buzz" },
        { key: "ProjectId", value: project.projectId },
      ],
    }),
  );
  const taskDefinitionArn = reg.taskDefinition?.taskDefinitionArn;
  if (!taskDefinitionArn) throw new Error("RegisterTaskDefinition returned no ARN");

  // 6) ECS service — create or update if it already exists
  const existingSvc = await describeService(cluster, svcName);
  if (existingSvc && existingSvc.status !== "INACTIVE") {
    await ecs.send(
      new UpdateServiceCommand({
        cluster,
        service: svcName,
        taskDefinition: taskDefinitionArn,
        desiredCount: 1,
        forceNewDeployment: true,
        healthCheckGracePeriodSeconds: 90,
      }),
    );
  } else {
    try {
      await ecs.send(
        new CreateServiceCommand({
          cluster,
          serviceName: svcName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          launchType: "FARGATE",
          platformVersion: "LATEST",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets,
              securityGroups: [securityGroup],
              assignPublicIp: "ENABLED",
            },
          },
          loadBalancers: [
            {
              targetGroupArn,
              containerName: "buzz",
              containerPort: 8080,
            },
          ],
          healthCheckGracePeriodSeconds: 90,
          deploymentConfiguration: {
            maximumPercent: 200,
            minimumHealthyPercent: 50,
          },
          enableExecuteCommand: false,
          tags: [
            { key: "Project", value: "buzz" },
            { key: "ProjectId", value: project.projectId },
            { key: "Subdomain", value: project.subdomain },
          ],
          propagateTags: "SERVICE",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Race: service appeared between describe and create
      if (/not idempotent|already exists/i.test(msg)) {
        await ecs.send(
          new UpdateServiceCommand({
            cluster,
            service: svcName,
            taskDefinition: taskDefinitionArn,
            desiredCount: 1,
            forceNewDeployment: true,
          }),
        );
      } else {
        throw err;
      }
    }
  }

  // 7) Wait until stable (or timeout)
  try {
    await waitUntilServicesStable(
      { client: ecs, maxWaitTime: 240, minDelay: 5, maxDelay: 15 },
      { cluster, services: [svcName] },
    );
  } catch (err) {
    // Surface partial state — caller may still mark failed
    const desc = await ecs.send(
      new DescribeServicesCommand({ cluster, services: [svcName] }),
    );
    const svc = desc.services?.[0];
    const events = (svc?.events ?? []).slice(0, 3).map((e) => e.message).join(" | ");
    throw new Error(
      `Service did not stabilize: ${err instanceof Error ? err.message : "timeout"}. Events: ${events}`,
    );
  }

  // Prefer pretty domain when Route53 wildcard is live; keep ALB path as fallback.
  const customDomain = process.env.CUSTOM_DOMAIN_ENABLED === "true";
  const pathUrl = `http://${albDns}/p/${project.subdomain}`;
  // http until ACM/HTTPS is added (after NS cutover)
  const url = customDomain ? `http://${project.domain}` : pathUrl;

  return {
    ecsCluster: cluster,
    ecsServiceName: svcName,
    taskDefinitionArn,
    targetGroupArn,
    listenerRuleArn,
    logGroupName,
    configS3Key,
    url,
  };
}

async function nextListenerPriority(listenerArn: string): Promise<number> {
  const used = new Set<number>();
  let marker: string | undefined;
  do {
    const res = await elbv2.send(
      new DescribeRulesCommand({
        ListenerArn: listenerArn,
        Marker: marker,
        PageSize: 100,
      }),
    );
    for (const rule of res.Rules ?? []) {
      if (rule.Priority && rule.Priority !== "default") {
        used.add(Number(rule.Priority));
      }
    }
    marker = res.NextMarker;
  } while (marker);

  for (let p = 10; p < 50000; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("No free ALB listener rule priorities");
}

async function findTargetGroupArn(name: string): Promise<string | undefined> {
  try {
    const res = await elbv2.send(
      new DescribeTargetGroupsCommand({ Names: [name] }),
    );
    return res.TargetGroups?.[0]?.TargetGroupArn;
  } catch {
    return undefined;
  }
}

async function findRuleArnForPath(
  listenerArn: string,
  pathValue: string,
): Promise<string | undefined> {
  let marker: string | undefined;
  do {
    const res = await elbv2.send(
      new DescribeRulesCommand({
        ListenerArn: listenerArn,
        Marker: marker,
        PageSize: 100,
      }),
    );
    for (const rule of res.Rules ?? []) {
      for (const c of rule.Conditions ?? []) {
        const values =
          c.PathPatternConfig?.Values ?? c.Values ?? [];
        if (values.some((v) => v === pathValue || v === `${pathValue}/*` || v.startsWith(pathValue))) {
          return rule.RuleArn;
        }
      }
    }
    marker = res.NextMarker;
  } while (marker);
  return undefined;
}

async function findRuleArnForHost(
  listenerArn: string,
  host: string,
): Promise<string | undefined> {
  let marker: string | undefined;
  do {
    const res = await elbv2.send(
      new DescribeRulesCommand({
        ListenerArn: listenerArn,
        Marker: marker,
        PageSize: 100,
      }),
    );
    for (const rule of res.Rules ?? []) {
      for (const c of rule.Conditions ?? []) {
        const values = c.HostHeaderConfig?.Values ?? c.Values ?? [];
        if (values.includes(host)) return rule.RuleArn;
      }
    }
    marker = res.NextMarker;
  } while (marker);
  return undefined;
}

async function describeService(cluster: string, name: string) {
  const res = await ecs.send(
    new DescribeServicesCommand({ cluster, services: [name] }),
  );
  return res.services?.[0];
}
