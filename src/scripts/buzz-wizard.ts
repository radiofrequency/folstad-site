import { slugify } from "../lib/slug";
import type { BuzzBotTemplate, BuzzSme } from "../data/buzz-sme";
import { getSession, requireSession } from "../lib/buzz-auth";
import { createProject, getProject, isMockApi } from "../lib/buzz-api";

type Bot = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
};

type WizardState = {
  step: string;
  projectName: string;
  subdomain: string;
  domainLocked: boolean;
  industryId: string;
  lastSeededIndustryId: string;
  bots: Bot[];
  industryFilter: string;
  projectId?: string;
};

const FLOW = [
  "welcome",
  "project",
  "domain",
  "account",
  "industry",
  "team",
  "confirm",
  "success",
] as const;

type StepId = (typeof FLOW)[number];

const DOMAIN_SUFFIX = ".folstad.ca";
const STORAGE_KEY = "buzz-wizard-v2";

function loadSme(): BuzzSme[] {
  const el = document.getElementById("buzz-sme-data");
  if (!el?.textContent) return [];
  try {
    return JSON.parse(el.textContent) as BuzzSme[];
  } catch {
    return [];
  }
}

const SME = loadSme();
const SME_BY_ID = Object.fromEntries(SME.map((s) => [s.id, s])) as Record<string, BuzzSme>;

function uid(prefix = "bot"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function applyProjectName(prompt: string, projectName: string): string {
  return prompt.replaceAll("{projectName}", projectName.trim() || "this business");
}

function seedBots(sme: BuzzSme, projectName: string): Bot[] {
  return sme.bots.map((b: BuzzBotTemplate) => ({
    id: uid(b.id),
    name: b.name,
    role: b.role,
    systemPrompt: applyProjectName(b.systemPrompt, projectName),
  }));
}

function defaultState(): WizardState {
  return {
    step: "welcome",
    projectName: "",
    subdomain: "project",
    domainLocked: false,
    industryId: "",
    lastSeededIndustryId: "",
    bots: [],
    industryFilter: "",
  };
}

function loadState(): WizardState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function saveState(state: WizardState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function fullDomain(sub: string): string {
  return `${sub || "project"}${DOMAIN_SUFFIX}`;
}

function isValidSubdomain(sub: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/.test(sub);
}

const root = document.querySelector<HTMLElement>("[data-buzz-wizard]");
if (root) {
  const state = loadState();
  if (state.step === "success" && !state.projectId) state.step = "confirm";
  // migrate old "email" step
  if ((state.step as string) === "email") state.step = "account";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(sel: string, el: ParentNode = root!): HTMLElement | null {
    return el.querySelector(sel);
  }

  function $all(sel: string, el: ParentNode = root!): HTMLElement[] {
    return Array.from(el.querySelectorAll(sel));
  }

  function setError(key: string, msg: string | null) {
    const err = $(`[data-error="${key}"]`);
    if (!err) return;
    if (msg) {
      err.hidden = false;
      err.textContent = msg;
    } else {
      err.hidden = true;
      err.textContent = "";
    }
  }

  function syncDomainFromName() {
    if (state.domainLocked) return;
    state.subdomain = slugify(state.projectName, "project");
  }

  function renderProgress() {
    const idx = FLOW.indexOf(state.step as StepId);
    $all("[data-step-dot]").forEach((dot) => {
      const id = dot.getAttribute("data-step-dot") ?? "";
      const di = FLOW.indexOf(id as StepId);
      dot.classList.toggle("is-active", id === state.step);
      dot.classList.toggle("is-done", di > 0 && di < idx);
    });
  }

  function renderAccount() {
    const box = $("[data-account-box]");
    if (!box) return;
    const session = getSession();
    const base = import.meta.env.BASE_URL;
    if (session?.emailVerified) {
      box.innerHTML = `
        <p class="buzz__hint" style="margin:0 0 0.5rem">Signed in as</p>
        <p style="margin:0;font-family:var(--font-display);font-size:var(--text-xl)">${esc(session.email)}</p>
        <p class="buzz__hint" style="margin:0.75rem 0 0">
          ${isMockApi() ? "Mock API (local)" : "Live API"} · Cognito-verified account
        </p>`;
      setError("account", null);
    } else {
      box.innerHTML = `
        <p class="buzz__hint" style="margin:0 0 1rem">You need a verified account to launch.</p>
        <a class="btn" href="${base}login?next=${encodeURIComponent(base + "buzz")}">Sign in</a>
        <a class="btn btn--ghost" href="${base}signup" style="margin-left:0.5rem">Create account</a>`;
    }
  }

  function renderIndustryList() {
    const q = state.industryFilter.trim().toLowerCase();
    $all("[data-industry-id]").forEach((btn) => {
      const id = btn.getAttribute("data-industry-id") ?? "";
      const sme = SME_BY_ID[id];
      const match =
        !q ||
        sme?.label.toLowerCase().includes(q) ||
        sme?.promise.toLowerCase().includes(q) ||
        sme?.group.toLowerCase().includes(q);
      btn.hidden = !match;
      btn.setAttribute("aria-selected", id === state.industryId ? "true" : "false");
    });
    $all("[data-industry-group]").forEach((group) => {
      const anyVisible = group.querySelectorAll("[data-industry-id]:not([hidden])").length > 0;
      group.hidden = !anyVisible;
    });
  }

  function renderTeam() {
    const list = $("[data-team-list]");
    if (!list) return;
    const label = $("[data-team-industry-label]");
    const sme = SME_BY_ID[state.industryId];
    if (label) label.textContent = sme?.label ?? "your industry";

    list.innerHTML = "";
    state.bots.forEach((bot, i) => {
      const card = document.createElement("article");
      card.className = "buzz__bot";
      card.dataset.botId = bot.id;
      card.innerHTML = `
        <div class="buzz__bot-head">
          <span class="buzz__bot-index">Agent ${String(i + 1).padStart(2, "0")}</span>
          <button type="button" class="buzz__bot-remove" data-remove-bot="${bot.id}">Remove</button>
        </div>
        <label class="buzz__field">
          <span class="buzz__label">Name</span>
          <input class="buzz__input" type="text" data-bot-field="name" data-bot-id="${bot.id}" value="" />
        </label>
        <label class="buzz__field">
          <span class="buzz__label">Role</span>
          <input class="buzz__input" type="text" data-bot-field="role" data-bot-id="${bot.id}" value="" />
        </label>
        <label class="buzz__field">
          <span class="buzz__label">System prompt</span>
          <textarea class="buzz__input buzz__textarea" data-bot-field="systemPrompt" data-bot-id="${bot.id}" rows="5"></textarea>
        </label>
      `;
      list.appendChild(card);
      const nameIn = card.querySelector<HTMLInputElement>('[data-bot-field="name"]');
      const roleIn = card.querySelector<HTMLInputElement>('[data-bot-field="role"]');
      const promptIn = card.querySelector<HTMLTextAreaElement>('[data-bot-field="systemPrompt"]');
      if (nameIn) nameIn.value = bot.name;
      if (roleIn) roleIn.value = bot.role;
      if (promptIn) promptIn.value = bot.systemPrompt;
    });
  }

  function renderRecap() {
    const sme = SME_BY_ID[state.industryId];
    const session = getSession();
    const map: Record<string, string> = {
      projectName: state.projectName || "—",
      domain: fullDomain(state.subdomain),
      email: session?.email ?? "—",
      industry: sme?.label ?? "—",
      bots: `${state.bots.length} agent${state.bots.length === 1 ? "" : "s"}`,
    };
    Object.entries(map).forEach(([k, v]) => {
      const el = $(`[data-recap="${k}"]`);
      if (el) el.textContent = v;
    });
  }

  function renderSuccessSummary() {
    const sme = SME_BY_ID[state.industryId];
    const set = (k: string, v: string) => {
      const el = $(`[data-success="${k}"]`);
      if (el) el.textContent = v;
    };
    set("projectName", state.projectName);
    set("domain", fullDomain(state.subdomain));
    set("industry", sme?.label ?? "—");
    set("botCount", String(state.bots.length));
    const ul = $("[data-success-bots]");
    if (ul) {
      ul.innerHTML = "";
      state.bots.forEach((b) => {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${esc(b.name)}</strong> <span>· ${esc(b.role)}</span>`;
        ul.appendChild(li);
      });
    }
    const dash = $("[data-dashboard-link]") as HTMLAnchorElement | null;
    if (dash && state.projectId) {
      dash.href = `${import.meta.env.BASE_URL}dashboard/project?id=${encodeURIComponent(state.projectId)}`;
    }
  }

  function esc(s: string): string {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function render() {
    root!.dataset.step = state.step;
    $all("[data-panel]").forEach((panel) => {
      const id = panel.getAttribute("data-panel");
      panel.hidden = id !== state.step;
    });

    const nameInput = $('[data-field="projectName"]') as HTMLInputElement | null;
    if (nameInput && nameInput.value !== state.projectName) nameInput.value = state.projectName;

    const subInput = $('[data-field="subdomain"]') as HTMLInputElement | null;
    if (subInput && subInput.value !== state.subdomain) subInput.value = state.subdomain;

    const filterInput = $('[data-field="industryFilter"]') as HTMLInputElement | null;
    if (filterInput && filterInput.value !== state.industryFilter)
      filterInput.value = state.industryFilter;

    const slugPrev = $("[data-slug-preview]");
    if (slugPrev) slugPrev.textContent = slugify(state.projectName, "project");

    const domainFull = $("[data-domain-full]");
    if (domainFull) domainFull.textContent = fullDomain(state.subdomain);

    renderProgress();
    if (state.step === "account") renderAccount();
    if (state.step === "industry") renderIndustryList();
    if (state.step === "team") renderTeam();
    if (state.step === "confirm") renderRecap();

    saveState(state);

    requestAnimationFrame(() => {
      const panel = $(`[data-panel="${state.step}"]`);
      const focusable = panel?.querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, button.btn:not(.btn--ghost)",
      );
      focusable?.focus({ preventScroll: true });
    });
  }

  function goTo(step: StepId) {
    state.step = step;
    render();
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function validateCurrent(): boolean {
    switch (state.step) {
      case "project": {
        if (!state.projectName.trim()) {
          setError("project", "Enter a project name.");
          return false;
        }
        setError("project", null);
        return true;
      }
      case "domain": {
        const sub = state.subdomain.trim().toLowerCase();
        if (!sub || !isValidSubdomain(sub)) {
          setError(
            "domain",
            "Use a valid subdomain: lowercase letters, numbers, hyphens (not starting/ending with hyphen).",
          );
          return false;
        }
        state.subdomain = sub;
        setError("domain", null);
        return true;
      }
      case "account": {
        const session = getSession();
        if (!session?.emailVerified) {
          setError("account", "Sign in with a verified email to continue.");
          renderAccount();
          return false;
        }
        setError("account", null);
        return true;
      }
      case "industry": {
        if (!state.industryId || !SME_BY_ID[state.industryId]) {
          setError("industry", "Select an industry to continue.");
          return false;
        }
        setError("industry", null);
        return true;
      }
      case "team": {
        if (state.bots.length < 1) {
          setError("team", "Keep at least one agent on the team.");
          return false;
        }
        const bad = state.bots.find(
          (b) => !b.name.trim() || !b.role.trim() || !b.systemPrompt.trim(),
        );
        if (bad) {
          setError("team", "Each agent needs a name, role, and system prompt.");
          return false;
        }
        setError("team", null);
        return true;
      }
      default:
        return true;
    }
  }

  function next() {
    if (!validateCurrent()) return;
    const idx = FLOW.indexOf(state.step as StepId);
    if (idx < 0 || idx >= FLOW.length - 1) return;

    if (FLOW[idx + 1] === "team") {
      const sme = SME_BY_ID[state.industryId];
      if (
        sme &&
        (state.bots.length === 0 || state.lastSeededIndustryId !== state.industryId)
      ) {
        state.bots = seedBots(sme, state.projectName);
        state.lastSeededIndustryId = state.industryId;
      }
    }

    if (FLOW[idx + 1] === "domain") {
      syncDomainFromName();
    }

    goTo(FLOW[idx + 1]);
  }

  function back() {
    const idx = FLOW.indexOf(state.step as StepId);
    if (idx <= 0) return;
    let prev = FLOW[idx - 1];
    if (prev === "success") prev = "confirm";
    goTo(prev);
  }

  async function runProvision() {
    if (!requireSession(`${import.meta.env.BASE_URL}buzz`)) return;

    const sme = SME_BY_ID[state.industryId];
    if (!sme) {
      setError("launch", "Pick an industry first.");
      return;
    }

    goTo("success");
    const provisionBlock = $("[data-provisioning]");
    const summaryBlock = $("[data-success-summary]");
    if (provisionBlock) provisionBlock.hidden = false;
    if (summaryBlock) summaryBlock.hidden = true;
    setError("provision", null);

    const steps = $all("[data-provision-step]");
    steps.forEach((s) => s.classList.remove("is-active", "is-done"));
    const statusEl = $("[data-provision-status]");

    const mark = (i: number, done = false) => {
      steps.forEach((s, idx) => {
        s.classList.toggle("is-active", idx === i && !done);
        s.classList.toggle("is-done", idx < i || (idx === i && done));
      });
    };

    try {
      mark(0);
      if (statusEl) statusEl.textContent = "Creating project…";
      const project = await createProject({
        projectName: state.projectName.trim(),
        subdomain: state.subdomain,
        industryId: sme.id,
        industryLabel: sme.label,
        bots: state.bots,
      });
      state.projectId = project.projectId;
      saveState(state);
      mark(0, true);
      mark(1);

      // Poll until running or failed
      const t0 = Date.now();
      let current = project;
      while (
        current.status === "provisioning" &&
        Date.now() - t0 < 30000
      ) {
        if (statusEl) statusEl.textContent = `Status: ${current.status}…`;
        await sleep(reduceMotion ? 200 : 700);
        current = await getProject(project.projectId);
        if (current.status !== "provisioning") break;
        mark(2);
      }

      if (current.status === "failed") {
        throw new Error(current.failureReason || "Provisioning failed");
      }

      mark(2, true);
      mark(3, true);
      if (statusEl) {
        statusEl.textContent = current.url
          ? `Ready — ${current.url}`
          : "Ready.";
      }
      await sleep(reduceMotion ? 0 : 300);

      if (provisionBlock) provisionBlock.hidden = true;
      if (summaryBlock) summaryBlock.hidden = false;
      // Prefer live ALB URL for success card domain line
      if (current.url) {
        const domainEl = $("[data-success='domain']");
        if (domainEl) domainEl.textContent = current.url;
      }
      renderSuccessSummary();
      if (current.url) {
        const domainEl = $("[data-success='domain']");
        if (domainEl) domainEl.textContent = current.url;
      }
      saveState(state);
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : "Launch failed";
      setError("provision", msg);
      if (statusEl) statusEl.textContent = "Failed.";
    }
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("[data-buzz-next]")) {
      e.preventDefault();
      next();
      return;
    }
    if (t.closest("[data-buzz-back]")) {
      e.preventDefault();
      back();
      return;
    }
    if (t.closest("[data-buzz-launch]")) {
      e.preventDefault();
      void runProvision();
      return;
    }
    if (t.closest("[data-buzz-restart]")) {
      e.preventDefault();
      Object.assign(state, defaultState());
      sessionStorage.removeItem(STORAGE_KEY);
      goTo("welcome");
      return;
    }
    if (t.closest("[data-add-bot]")) {
      e.preventDefault();
      state.bots.push({
        id: uid("custom"),
        name: "New agent",
        role: "Custom role",
        systemPrompt: `You are a custom agent for ${state.projectName || "this business"}. Follow company policies. Never invent facts. Escalate uncertainty to a human.`,
      });
      renderTeam();
      saveState(state);
      return;
    }
    const remove = t.closest<HTMLElement>("[data-remove-bot]");
    if (remove) {
      e.preventDefault();
      const id = remove.getAttribute("data-remove-bot");
      state.bots = state.bots.filter((b) => b.id !== id);
      renderTeam();
      saveState(state);
      return;
    }
    const industryBtn = t.closest<HTMLElement>("[data-industry-id]");
    if (industryBtn) {
      e.preventDefault();
      state.industryId = industryBtn.getAttribute("data-industry-id") ?? "";
      setError("industry", null);
      renderIndustryList();
      saveState(state);
    }
  });

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement;
    const field = t.getAttribute("data-field");
    if (field === "projectName") {
      state.projectName = t.value;
      syncDomainFromName();
      const slugPrev = $("[data-slug-preview]");
      if (slugPrev) slugPrev.textContent = slugify(state.projectName, "project");
      saveState(state);
      return;
    }
    if (field === "subdomain") {
      state.domainLocked = true;
      state.subdomain = t.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (t.value !== state.subdomain) t.value = state.subdomain;
      const domainFull = $("[data-domain-full]");
      if (domainFull) domainFull.textContent = fullDomain(state.subdomain);
      saveState(state);
      return;
    }
    if (field === "industryFilter") {
      state.industryFilter = t.value;
      renderIndustryList();
      return;
    }

    const botField = t.getAttribute("data-bot-field") as keyof Bot | null;
    const botId = t.getAttribute("data-bot-id");
    if (botField && botId) {
      const bot = state.bots.find((b) => b.id === botId);
      if (bot && botField !== "id") {
        bot[botField] = t.value;
        saveState(state);
      }
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA") return;
    if (t.closest("[data-panel]")) {
      if ((t as HTMLInputElement).getAttribute?.("data-field") === "industryFilter") return;
      e.preventDefault();
      if (state.step === "confirm") void runProvision();
      else if (state.step !== "success") next();
    }
  });

  render();
}
