/** Shared Buzz API + project contracts (site, Lambda, infra). */

export type ProjectStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "deleting";

export type ProjectHealth = "unknown" | "healthy" | "unhealthy";

export type BuzzBot = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
};

export type Project = {
  projectId: string;
  ownerSub: string;
  ownerEmail: string;
  projectName: string;
  subdomain: string;
  domain: string;
  industryId: string;
  industryLabel: string;
  bots: BuzzBot[];
  status: ProjectStatus;
  health: ProjectHealth;
  healthCheckedAt?: string;
  failureReason?: string;
  ecsCluster?: string;
  ecsServiceName?: string;
  taskDefinitionArn?: string;
  targetGroupArn?: string;
  listenerRuleArn?: string;
  logGroupName?: string;
  configS3Key?: string;
  /** Working URL (ALB path) once provisioned — may differ from custom domain until DNS is set. */
  url?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectRequest = {
  projectName: string;
  subdomain: string;
  industryId: string;
  industryLabel: string;
  bots: BuzzBot[];
};

export type CreateProjectResponse = {
  project: Project;
};

export type ListProjectsResponse = {
  projects: Project[];
};

export type GetProjectResponse = {
  project: Project;
};

export type HealthResponse = {
  projectId: string;
  status: ProjectStatus;
  health: ProjectHealth;
  healthCheckedAt: string;
  detail?: string;
};

export type LogsResponse = {
  projectId: string;
  lines: Array<{ ts: string; message: string }>;
};

export type ApiErrorBody = {
  error: string;
  code?: string;
};

export const DOMAIN_SUFFIX = ".folstad.ca";

export function fullDomain(subdomain: string): string {
  return `${subdomain}${DOMAIN_SUFFIX}`;
}
