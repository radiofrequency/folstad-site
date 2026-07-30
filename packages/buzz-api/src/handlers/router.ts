import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { fullDomain, type Project } from "@folstad/buzz-shared";
import { error, getUser, json, noContent } from "../lib/http";
import { parseCreateBody } from "../lib/validate";
import {
  getProjectById,
  getProjectBySubdomain,
  listProjectsByOwner,
  putProject,
  updateProject,
} from "../lib/ddb";
import { restartService, serviceHealth, stopService } from "../lib/ecs";
import { tailLogs } from "../lib/logs";
import { provisionHandler } from "../workers/provision";

const lambda = new LambdaClient({});

function pathOf(event: APIGatewayProxyEventV2): string {
  const raw = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  return raw.replace(/^\/v1/, "") || "/";
}

function methodOf(event: APIGatewayProxyEventV2): string {
  return (event.requestContext?.http?.method ?? "GET").toUpperCase();
}

async function requireOwner(
  projectId: string,
  sub: string,
): Promise<Project | APIGatewayProxyResultV2> {
  const project = await getProjectById(projectId);
  if (!project) return error(404, "Project not found", "NOT_FOUND");
  if (project.ownerSub !== sub) return error(403, "Forbidden", "FORBIDDEN");
  return project;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (methodOf(event) === "OPTIONS") return noContent();

  const user = getUser(event);
  if (!user) return error(401, "Unauthorized", "UNAUTHORIZED");
  if (!user.emailVerified) {
    return error(403, "Email not verified", "EMAIL_UNVERIFIED");
  }

  const method = methodOf(event);
  const path = pathOf(event);

  try {
    // POST /projects
    if (method === "POST" && path === "/projects") {
      let body: unknown = {};
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return error(400, "Invalid JSON");
      }
      const parsed = parseCreateBody(body);
      if (typeof parsed === "string") return error(400, parsed, "VALIDATION");

      const existing = await getProjectBySubdomain(parsed.subdomain);
      if (existing) return error(409, "Subdomain already taken", "SUBDOMAIN_TAKEN");

      const now = new Date().toISOString();
      const projectId = crypto.randomUUID();
      const project: Project = {
        projectId,
        ownerSub: user.sub,
        ownerEmail: user.email,
        projectName: parsed.projectName,
        subdomain: parsed.subdomain,
        domain: fullDomain(parsed.subdomain),
        industryId: parsed.industryId,
        industryLabel: parsed.industryLabel,
        bots: parsed.bots,
        status: "provisioning",
        health: "unknown",
        createdAt: now,
        updatedAt: now,
        logGroupName: `/buzz/${projectId}`,
        configS3Key: `configs/${projectId}.json`,
      };

      try {
        await putProject(project);
      } catch {
        return error(409, "Could not create project (conflict)", "CONFLICT");
      }

      // Async provision (must be separate invoke — API Lambda freezes after response)
      const worker = process.env.PROVISION_FUNCTION_NAME;
      if (worker) {
        await lambda.send(
          new InvokeCommand({
            FunctionName: worker,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ projectId })),
          }),
        );
      } else {
        // Local/dev fallback only
        void provisionHandler({ projectId });
      }

      return json(201, { project });
    }

    // GET /projects
    if (method === "GET" && path === "/projects") {
      const projects = await listProjectsByOwner(user.sub);
      return json(200, { projects });
    }

    // GET /projects/:id
    const getMatch = /^\/projects\/([^/]+)$/.exec(path);
    if (method === "GET" && getMatch) {
      const result = await requireOwner(getMatch[1], user.sub);
      if ("statusCode" in result) return result;
      return json(200, { project: result });
    }

    // GET /projects/:id/health
    const healthMatch = /^\/projects\/([^/]+)\/health$/.exec(path);
    if (method === "GET" && healthMatch) {
      const result = await requireOwner(healthMatch[1], user.sub);
      if ("statusCode" in result) return result;

      let status = result.status;
      let health = result.health;
      let detail = "";

      if (process.env.ECS_CLUSTER && result.ecsServiceName) {
        const h = await serviceHealth(result);
        status = h.status;
        health = h.health;
        detail = h.detail;
      } else if (result.status === "running") {
        health = "healthy";
        detail = "mock healthy";
      }

      const healthCheckedAt = new Date().toISOString();
      await updateProject(result.projectId, { status, health, healthCheckedAt });

      return json(200, {
        projectId: result.projectId,
        status,
        health,
        healthCheckedAt,
        detail,
      });
    }

    // POST /projects/:id/stop
    const stopMatch = /^\/projects\/([^/]+)\/stop$/.exec(path);
    if (method === "POST" && stopMatch) {
      const result = await requireOwner(stopMatch[1], user.sub);
      if ("statusCode" in result) return result;

      if (process.env.ECS_CLUSTER && result.ecsServiceName) {
        await stopService(result);
      }
      const project = await updateProject(result.projectId, {
        status: "stopped",
        health: "unknown",
      });
      return json(200, { project });
    }

    // POST /projects/:id/restart
    const restartMatch = /^\/projects\/([^/]+)\/restart$/.exec(path);
    if (method === "POST" && restartMatch) {
      const result = await requireOwner(restartMatch[1], user.sub);
      if ("statusCode" in result) return result;

      if (process.env.ECS_CLUSTER && result.ecsServiceName) {
        await restartService(result);
      }
      const project = await updateProject(result.projectId, {
        status: "provisioning",
        health: "unknown",
      });
      // Mock: flip to running shortly when no ECS
      if (!process.env.ECS_CLUSTER) {
        setTimeout(() => {
          void updateProject(result.projectId, {
            status: "running",
            health: "healthy",
            healthCheckedAt: new Date().toISOString(),
          });
        }, 1200);
      }
      return json(200, { project });
    }

    // GET /projects/:id/logs
    const logsMatch = /^\/projects\/([^/]+)\/logs$/.exec(path);
    if (method === "GET" && logsMatch) {
      const result = await requireOwner(logsMatch[1], user.sub);
      if ("statusCode" in result) return result;

      const limit = Number(event.queryStringParameters?.limit ?? "200");
      if (result.logGroupName && process.env.AWS_REGION) {
        const lines = await tailLogs(result.logGroupName, limit);
        return json(200, { projectId: result.projectId, lines });
      }

      // Mock logs
      return json(200, {
        projectId: result.projectId,
        lines: [
          {
            ts: result.createdAt,
            message: `[buzz] project ${result.projectName} created`,
          },
          {
            ts: result.updatedAt,
            message: `[buzz] status=${result.status} health=${result.health}`,
          },
          {
            ts: new Date().toISOString(),
            message: `[buzz] domain https://${result.domain}`,
          },
          {
            ts: new Date().toISOString(),
            message: `[buzz] ${result.bots.length} agents configured`,
          },
        ],
      });
    }

    return error(404, "Not found");
  } catch (err) {
    console.error(err);
    return error(500, err instanceof Error ? err.message : "Internal error");
  }
};

export { provisionHandler };
