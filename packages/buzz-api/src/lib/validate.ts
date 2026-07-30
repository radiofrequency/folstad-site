import type { BuzzBot, CreateProjectRequest } from "@folstad/buzz-shared";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

export function parseCreateBody(raw: unknown): CreateProjectRequest | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object";
  const b = raw as Record<string, unknown>;

  const projectName = String(b.projectName ?? "").trim();
  if (!projectName) return "projectName is required";

  const subdomain = String(b.subdomain ?? "")
    .trim()
    .toLowerCase();
  if (!SUBDOMAIN_RE.test(subdomain)) return "Invalid subdomain";

  const industryId = String(b.industryId ?? "").trim();
  const industryLabel = String(b.industryLabel ?? "").trim();
  if (!industryId || !industryLabel) return "industryId and industryLabel are required";

  if (!Array.isArray(b.bots) || b.bots.length < 1) return "At least one bot is required";

  const bots: BuzzBot[] = [];
  for (const item of b.bots) {
    if (!item || typeof item !== "object") return "Invalid bot entry";
    const bot = item as Record<string, unknown>;
    const id = String(bot.id ?? "").trim() || crypto.randomUUID();
    const name = String(bot.name ?? "").trim();
    const role = String(bot.role ?? "").trim();
    const systemPrompt = String(bot.systemPrompt ?? "").trim();
    if (!name || !role || !systemPrompt) {
      return "Each bot needs name, role, and systemPrompt";
    }
    bots.push({ id, name, role, systemPrompt });
  }

  return { projectName, subdomain, industryId, industryLabel, bots };
}
