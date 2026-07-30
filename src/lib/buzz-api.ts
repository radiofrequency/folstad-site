import type {
  CreateProjectRequest,
  Project,
  ProjectHealth,
  ProjectStatus,
} from "./buzz-types";
import { getSession } from "./buzz-auth";

/** Production API Gateway. Override with PUBLIC_BUZZ_API_URL if needed. */
const DEFAULT_API_URL = "https://ej7p79nn47.execute-api.us-west-2.amazonaws.com/v1";

function apiBase(): string {
  const u = import.meta.env.PUBLIC_BUZZ_API_URL as string | undefined;
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
  const res = await fetch(`${apiBase()}${path}`, {
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
