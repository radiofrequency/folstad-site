import {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
} from "@aws-sdk/client-ecs";
import type { Project, ProjectHealth, ProjectStatus } from "@folstad/buzz-shared";

const ecs = new ECSClient({});

function cluster() {
  return process.env.ECS_CLUSTER ?? "buzz";
}

/** Stop: desired count 0 */
export async function stopService(project: Project): Promise<void> {
  if (!project.ecsServiceName) throw new Error("No ECS service");
  await ecs.send(
    new UpdateServiceCommand({
      cluster: project.ecsCluster || cluster(),
      service: project.ecsServiceName,
      desiredCount: 0,
    }),
  );
}

/** Restart: scale to 1 or force new deployment */
export async function restartService(project: Project): Promise<"start" | "redeploy"> {
  if (!project.ecsServiceName) throw new Error("No ECS service");
  const clusterName = project.ecsCluster || cluster();
  const desc = await ecs.send(
    new DescribeServicesCommand({
      cluster: clusterName,
      services: [project.ecsServiceName],
    }),
  );
  const svc = desc.services?.[0];
  const desired = svc?.desiredCount ?? 0;

  if (desired === 0) {
    await ecs.send(
      new UpdateServiceCommand({
        cluster: clusterName,
        service: project.ecsServiceName,
        desiredCount: 1,
      }),
    );
    return "start";
  }

  await ecs.send(
    new UpdateServiceCommand({
      cluster: clusterName,
      service: project.ecsServiceName,
      forceNewDeployment: true,
    }),
  );
  return "redeploy";
}

export async function serviceHealth(
  project: Project,
): Promise<{ status: ProjectStatus; health: ProjectHealth; detail: string }> {
  if (!project.ecsServiceName) {
    return { status: project.status, health: "unknown", detail: "No ECS service yet" };
  }

  const clusterName = project.ecsCluster || cluster();
  const desc = await ecs.send(
    new DescribeServicesCommand({
      cluster: clusterName,
      services: [project.ecsServiceName],
    }),
  );
  const svc = desc.services?.[0];
  if (!svc) {
    return { status: "failed", health: "unhealthy", detail: "Service not found" };
  }

  const desired = svc.desiredCount ?? 0;
  const running = svc.runningCount ?? 0;

  if (desired === 0) {
    return { status: "stopped", health: "unknown", detail: "desiredCount=0" };
  }
  if (running >= 1) {
    return { status: "running", health: "healthy", detail: `running=${running}` };
  }
  if (svc.deployments?.some((d) => d.rolloutState === "FAILED")) {
    return { status: "failed", health: "unhealthy", detail: "Deployment failed" };
  }
  return {
    status: "provisioning",
    health: "unknown",
    detail: `desired=${desired} running=${running}`,
  };
}
