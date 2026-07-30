/**
 * Minimal Buzz project runtime: landing page + /health.
 * Loads optional PROJECT_CONFIG_JSON env (inline) for display.
 */
import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

type Config = {
  projectId?: string;
  projectName?: string;
  domain?: string;
  industryLabel?: string;
  bots?: Array<{ name: string; role: string }>;
};

function loadConfig(): Config {
  const raw = process.env.PROJECT_CONFIG_JSON;
  if (!raw) {
    return {
      projectName: process.env.PROJECT_NAME ?? "Buzz project",
      domain: process.env.PROJECT_DOMAIN ?? "localhost",
      industryLabel: "General",
      bots: [],
    };
  }
  try {
    return JSON.parse(raw) as Config;
  } catch {
    return { projectName: "Buzz project", bots: [] };
  }
}

const config = loadConfig();
let ready = true;

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/health" || url === "/healthz") {
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: ready,
        projectId: config.projectId,
        projectName: config.projectName,
      }),
    );
    return;
  }

  // Landing for / and ALB path prefixes like /p/{subdomain}
  if (req.method === "GET" || req.method === "HEAD") {
    const bots = (config.bots ?? [])
      .map((b) => `<li><strong>${esc(b.name)}</strong> · ${esc(b.role)}</li>`)
      .join("");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(config.projectName ?? "Buzz")} · live</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1.25rem; color: #1a1c22; background: #f7f6f3; }
    h1 { font-weight: 500; letter-spacing: -0.02em; }
    .meta { color: #5c6370; }
    ul { padding-left: 1.1rem; }
  </style>
</head>
<body>
  <p class="meta">Buzz runtime</p>
  <h1>${esc(config.projectName ?? "Project")} is live.</h1>
  <p class="meta">${esc(config.domain ?? "")} · ${esc(config.industryLabel ?? "")}</p>
  ${bots ? `<h2>Agents</h2><ul>${bots}</ul>` : ""}
</body>
</html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(html);
    }
    return;
  }

  res.writeHead(404).end("Not found");
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "buzz-runtime listening",
      port,
      projectName: config.projectName,
    }),
  );
});

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
