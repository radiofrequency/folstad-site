import type {
  CreateProjectRequest,
  Project,
  ProjectHealth,
  ProjectStatus,
} from "./buzz-types";
import { fullDomain } from "./buzz-types";
import { getSession } from "./buzz-auth";

const MOCK_PROJECTS_KEY = "buzz-mock-projects";

/** Production API Gateway (public). Override with PUBLIC_BUZZ_API_URL. */
const DEFAULT_API_URL = "https://ej7p79nn47.execute-api.us-west-2.amazonaws.com/v1";

function apiBase(): string | null {
  const u = import.meta.env.PUBLIC_BUZZ_API_URL as string | undefined;
  if (u === "mock" || u === "off") return null;
  const base = (u && u.trim()) || DEFAULT_API_URL;
  return base.replace(/\/$/, "");
}

function authHeader(): HeadersInit {
  const s = getSession();
  if (!s?.accessToken) throw new Error("Not signed in");
  return {
    Authorization: `Bearer ${s.accessToken}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = apiBase();
  if (!base) return mockFetch<T>(path, init);

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ——— Public API ———

export async function listProjects(): Promise<Project[]> {
  const data = await apiFetch<{ projects: Project[] }>("/projects");
  return data.projects;
}

export async function getProject(id: string): Promise<Project> {
  const data = await apiFetch<{ project: Project }>(`/projects/${id}`);
  return data.project;
}

export async function createProject(body: CreateProjectRequest): Promise<Project> {
  const data = await apiFetch<{ project: Project }>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function refreshHealth(id: string): Promise<{
  status: ProjectStatus;
  health: ProjectHealth;
  healthCheckedAt: string;
  detail?: string;
}> {
  return apiFetch(`/projects/${id}/health`);
}

export async function stopProject(id: string): Promise<Project> {
  const data = await apiFetch<{ project: Project }>(`/projects/${id}/stop`, {
    method: "POST",
  });
  return data.project;
}

export async function restartProject(id: string): Promise<Project> {
  const data = await apiFetch<{ project: Project }>(`/projects/${id}/restart`, {
    method: "POST",
  });
  return data.project;
}

export async function getLogs(
  id: string,
  limit = 200,
): Promise<Array<{ ts: string; message: string }>> {
  const data = await apiFetch<{ lines: Array<{ ts: string; message: string }> }>(
    `/projects/${id}/logs?limit=${limit}`,
  );
  return data.lines;
}

export function isMockApi(): boolean {
  return apiBase() === null;
}

// ——— In-browser mock control plane ———

function loadMockProjects(): Project[] {
  try {
    return JSON.parse(localStorage.getItem(MOCK_PROJECTS_KEY) ?? "[]") as Project[];
  } catch {
    return [];
  }
}

function saveMockProjects(projects: Project[]) {
  localStorage.setItem(MOCK_PROJECTS_KEY, JSON.stringify(projects));
}

async function mockFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const session = getSession();
  if (!session?.emailVerified) throw new Error("Unauthorized");

  const method = (init?.method ?? "GET").toUpperCase();
  await delay(180);

  if (method === "GET" && path === "/projects") {
    const projects = loadMockProjects().filter((p) => p.ownerSub === session.sub);
    return { projects } as T;
  }

  if (method === "POST" && path === "/projects") {
    const body = JSON.parse(String(init?.body ?? "{}")) as CreateProjectRequest;
    const all = loadMockProjects();
    if (all.some((p) => p.subdomain === body.subdomain)) {
      throw new Error("Subdomain already taken");
    }
    const now = new Date().toISOString();
    const project: Project = {
      projectId: crypto.randomUUID(),
      ownerSub: session.sub,
      ownerEmail: session.email,
      projectName: body.projectName,
      subdomain: body.subdomain,
      domain: fullDomain(body.subdomain),
      industryId: body.industryId,
      industryLabel: body.industryLabel,
      bots: body.bots,
      status: "provisioning",
      health: "unknown",
      createdAt: now,
      updatedAt: now,
      logGroupName: `/buzz/mock`,
    };
    all.unshift(project);
    saveMockProjects(all);

    // Simulate async provision
    setTimeout(() => {
      const list = loadMockProjects();
      const p = list.find((x) => x.projectId === project.projectId);
      if (p) {
        p.status = "running";
        p.health = "healthy";
        p.healthCheckedAt = new Date().toISOString();
        p.updatedAt = p.healthCheckedAt;
        saveMockProjects(list);
      }
    }, 1600);

    return { project } as T;
  }

  const idMatch = /^\/projects\/([^/]+)(.*)$/.exec(path);
  if (!idMatch) throw new Error("Not found");
  const id = idMatch[1];
  const rest = idMatch[2] || "";

  const all = loadMockProjects();
  const project = all.find((p) => p.projectId === id);
  if (!project || project.ownerSub !== session.sub) throw new Error("Project not found");

  if (method === "GET" && rest === "") {
    return { project } as T;
  }

  if (method === "GET" && rest === "/health") {
    const healthCheckedAt = new Date().toISOString();
    project.healthCheckedAt = healthCheckedAt;
    if (project.status === "running") project.health = "healthy";
    if (project.status === "stopped") project.health = "unknown";
    project.updatedAt = healthCheckedAt;
    saveMockProjects(all);
    return {
      projectId: id,
      status: project.status,
      health: project.health,
      healthCheckedAt,
      detail: "mock",
    } as T;
  }

  if (method === "POST" && rest === "/stop") {
    project.status = "stopped";
    project.health = "unknown";
    project.updatedAt = new Date().toISOString();
    saveMockProjects(all);
    return { project } as T;
  }

  if (method === "POST" && rest === "/restart") {
    project.status = "provisioning";
    project.health = "unknown";
    project.updatedAt = new Date().toISOString();
    saveMockProjects(all);
    setTimeout(() => {
      const list = loadMockProjects();
      const p = list.find((x) => x.projectId === id);
      if (p) {
        p.status = "running";
        p.health = "healthy";
        p.healthCheckedAt = new Date().toISOString();
        p.updatedAt = p.healthCheckedAt;
        saveMockProjects(list);
      }
    }, 1200);
    return { project } as T;
  }

  if (method === "GET" && rest.startsWith("/logs")) {
    return {
      projectId: id,
      lines: [
        { ts: project.createdAt, message: `[buzz] created ${project.projectName}` },
        {
          ts: project.updatedAt,
          message: `[buzz] status=${project.status} health=${project.health}`,
        },
        {
          ts: new Date().toISOString(),
          message: `[buzz] https://${project.domain} · ${project.bots.length} agents`,
        },
        {
          ts: new Date().toISOString(),
          message: `[buzz] owner ${project.ownerEmail}`,
        },
      ],
    } as T;
  }

  throw new Error("Not found");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
