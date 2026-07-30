/**
 * Async provision worker Lambda.
 * Event: { projectId: string }
 */
import type { Project } from "@folstad/buzz-shared";
import { getProjectById, updateProject } from "../lib/ddb";
import { provisionProject } from "../lib/provision-aws";

export type ProvisionEvent = { projectId: string };

export async function provisionHandler(event: ProvisionEvent): Promise<void> {
  const projectId = event?.projectId;
  if (!projectId) {
    console.error("provision: missing projectId", event);
    return;
  }

  const project = await getProjectById(projectId);
  if (!project) {
    console.error("provision: project not found", projectId);
    return;
  }

  if (project.status === "running" && project.ecsServiceName) {
    console.info("provision: already running", projectId);
    return;
  }

  try {
    await updateProject(projectId, {
      status: "provisioning",
      health: "unknown",
      failureReason: null,
    });

    const hasEcs = Boolean(
      process.env.ECS_CLUSTER &&
        process.env.RUNTIME_IMAGE &&
        process.env.ALB_LISTENER_ARN &&
        process.env.ECS_EXECUTION_ROLE_ARN,
    );

    if (!hasEcs) {
      await sleep(1500);
      await updateProject(projectId, {
        status: "running",
        health: "healthy",
        healthCheckedAt: new Date().toISOString(),
        ecsCluster: "local-mock",
        ecsServiceName: `buzz-mock-${project.subdomain}`,
        logGroupName: `/buzz/${projectId}`,
        configS3Key: `configs/${projectId}.json`,
      } satisfies Partial<Project>);
      return;
    }

    const result = await provisionProject(project);

    await updateProject(projectId, {
      status: "running",
      health: "healthy",
      healthCheckedAt: new Date().toISOString(),
      failureReason: null,
      ecsCluster: result.ecsCluster,
      ecsServiceName: result.ecsServiceName,
      taskDefinitionArn: result.taskDefinitionArn,
      targetGroupArn: result.targetGroupArn,
      listenerRuleArn: result.listenerRuleArn,
      logGroupName: result.logGroupName,
      configS3Key: result.configS3Key,
      url: result.url,
    });

    console.info("provision: success", { projectId, url: result.url, service: result.ecsServiceName });
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : "provision failed";
    console.error("provision: failed", projectId, failureReason);
    await updateProject(projectId, {
      status: "failed",
      health: "unhealthy",
      failureReason,
    });
  }
}

/** Lambda entrypoint */
export async function handler(event: ProvisionEvent): Promise<{ ok: boolean }> {
  await provisionHandler(event);
  return { ok: true };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
