/** Re-export shared contracts for the Astro site (no package resolution needed). */

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
  logGroupName?: string;
  configS3Key?: string;
  /** Working URL on shared ALB (path-based). */
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

export const DOMAIN_SUFFIX = ".folstad.ca";

export function fullDomain(subdomain: string): string {
  return `${subdomain}${DOMAIN_SUFFIX}`;
}
