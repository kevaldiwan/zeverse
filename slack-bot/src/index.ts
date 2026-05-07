import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load .env: optional cwd file first, then monorepo root last with override
// so `.env` at the repo root always wins (fixes empty ZEVERSE_* when a nested .env was loaded first).
{
  const projectEnv = path.resolve(__dirname, "../..", ".env");
  const cwdEnv = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnv) && path.resolve(cwdEnv) !== projectEnv) {
    dotenv.config({ path: cwdEnv, override: true });
  }
  dotenv.config({ path: projectEnv, override: true });
}

import { App, LogLevel } from "@slack/bolt";
import {
  formatLLMTextForSlack,
  sanitizeForSlackMrkdwn,
  wrapWorkflowSummary,
} from "./format-slack-message";
import {
  extractJestSummary,
  findStepOutputWithJestSummary,
  formatJestStatusHeader,
  jestSummaryHasFailures,
} from "./jest-summary";

const ZEVERSE_SERVER_URL = process.env.ZEVERSE_SERVER_URL ?? "http://localhost:3100";
const ZEVERSE_UI_URL = process.env.ZEVERSE_UI_URL ?? "http://localhost:5173";
const DEFAULT_REPO_ID = process.env.ZEVERSE_DEFAULT_REPO_ID ?? "";
const DEFAULT_WORKFLOW = process.env.ZEVERSE_DEFAULT_WORKFLOW ?? "dev";
const HUB_STATE_DIR = path.resolve(__dirname, "../../state");

/** Zeverse API returns JSON; HTML means wrong URL (UI/static host) or proxy misconfiguration. */
async function zeverseResponseJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const t = text.trim();
  if (t.startsWith("<!DOCTYPE") || t.startsWith("<!doctype") || t.startsWith("<html")) {
    throw new Error(
      `Zeverse server returned a web page instead of JSON (${what}, HTTP ${res.status}). ` +
        `Set ZEVERSE_SERVER_URL in .env to the API (e.g. http://127.0.0.1:3100), not the Vite UI, and ensure the server is running.`
    );
  }
  if (t.length > 0 && t[0] !== "{" && t[0] !== "[") {
    const preview = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    throw new Error(
      `Zeverse server did not return JSON (${what}, HTTP ${res.status}): ${preview}`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const msg = (e as Error).message;
    if (
      msg.includes("Unexpected token") &&
      (text.includes("<!DOCTYPE") || text.includes("<html") || text.trim().startsWith("<"))
    ) {
      throw new Error(
        `Zeverse returned a web page, not JSON (${what}, HTTP ${res.status}). ` +
          `Point ZEVERSE_SERVER_URL at the API (http://127.0.0.1:3100), not the Vite UI, ` +
          `and unset a wrong value in the shell: env -u ZEVERSE_SERVER_URL npm run dev:slack`
      );
    }
    throw new Error(
      `Invalid JSON from Zeverse ${what} (HTTP ${res.status}): ${msg}`
    );
  }
}

function zeverseBaseUrl(): string {
  return ZEVERSE_SERVER_URL.replace(/\/$/, "");
}

/** Warn at boot if the API URL looks wrong or returns HTML. */
async function probeZeverseOnStartup(): Promise<void> {
  const base = zeverseBaseUrl();
  if (/^https?:\/\/127\.0\.0\.1:5173|^https?:\/\/localhost:5173/.test(base)) {
    console.warn(
      "Zeverse: ZEVERSE_SERVER_URL is the Vite dev URL (5173). The bot needs the API on 3100. Set ZEVERSE_SERVER_URL=http://127.0.0.1:3100 in .env"
    );
  }
  try {
    const res = await fetch(`${base}/api/repos`);
    const text = await res.text();
    const t = text.trim();
    if (t.startsWith("<!DOCTYPE") || t.startsWith("<!doctype") || t.startsWith("<html")) {
      console.error(
        "Zeverse: GET /api/repos returned HTML — ZEVERSE_SERVER_URL is wrong, or the shell is overriding .env. " +
          "Use the API: http://127.0.0.1:3100. Test with: npm run check:zeverse"
      );
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      console.error(
        `Zeverse: /api/repos body is not valid JSON (HTTP ${res.status}):`,
        text.slice(0, 200)
      );
      return;
    }
    console.log(`Zeverse: API OK at ${base} (GET /api/repos → ${res.status})`);
  } catch (e) {
    console.error(`Zeverse: cannot reach ${base}:`, (e as Error).message);
  }
  const adminN = (process.env.ZEVERSE_REPO_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  if (adminN === 0) {
    console.warn(
      "Zeverse: ZEVERSE_REPO_ADMIN_USER_IDS is empty — add-repo from Slack will be denied. " +
        "Set it in `.env` at the repo root and restart the bot."
    );
  } else {
    console.log(`Zeverse: add-repo: ${adminN} admin user id(s) in env`);
  }
}

// ─── PRD thread tracking ───────────────────────────────────────────────────
type QuerySeverity = "critical" | "nice-to-have";

interface PrdQueryInfo {
  index: number;
  body: string;
  anchor: string;
  commentId: string;
  severity?: QuerySeverity;
  assignedUserId?: string;
}

interface PrdThreadContext {
  channel: string;
  threadTs: string;
  repoId: string;
  docUrl: string;
  docId: string;
  runId: string;
  queries: PrdQueryInfo[];
}

// key = `${channel}:${threadTs}`
const prdThreads = new Map<string, PrdThreadContext>();

// secondary index: docUrl -> list of thread keys (for re-run lookup)
const prdDocIndex = new Map<string, string[]>();

function prdThreadDir(repoId: string): string {
  return path.join(HUB_STATE_DIR, repoId, "prd-threads");
}

function savePrdThread(ctx: PrdThreadContext): void {
  const key = `${ctx.channel}:${ctx.threadTs}`;
  prdThreads.set(key, ctx);

  const existing = prdDocIndex.get(ctx.docUrl) ?? [];
  if (!existing.includes(key)) existing.push(key);
  prdDocIndex.set(ctx.docUrl, existing);

  const dir = prdThreadDir(ctx.repoId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = ctx.threadTs.replace(/\./g, "_");
  fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(ctx, null, 2));
}

function lookupPrdThread(channel: string, threadTs: string): PrdThreadContext | undefined {
  return prdThreads.get(`${channel}:${threadTs}`);
}

/**
 * Fallback lookup: find the most recently saved PRD thread for a channel.
 * Needed because slash commands don't provide a `ts`, so the saved threadTs
 * may not match the actual Slack thread parent ts.
 */
function lookupPrdThreadByChannel(channel: string): PrdThreadContext | undefined {
  let best: PrdThreadContext | undefined;
  for (const ctx of prdThreads.values()) {
    if (ctx.channel !== channel) continue;
    if (!best) { best = ctx; continue; }
    if (ctx.threadTs > best.threadTs) best = ctx;
  }
  return best;
}

function lookupPrdThreadsByDocUrl(docUrl: string): PrdThreadContext[] {
  const keys = prdDocIndex.get(docUrl) ?? [];
  return keys.map((k) => prdThreads.get(k)).filter(Boolean) as PrdThreadContext[];
}

function loadAllPrdThreads(): void {
  if (!fs.existsSync(HUB_STATE_DIR)) return;
  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const dir = prdThreadDir(repoId);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ctx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PrdThreadContext;
        const key = `${ctx.channel}:${ctx.threadTs}`;
        prdThreads.set(key, ctx);
        const existing = prdDocIndex.get(ctx.docUrl) ?? [];
        if (!existing.includes(key)) existing.push(key);
        prdDocIndex.set(ctx.docUrl, existing);
      } catch {
        // skip corrupt files
      }
    }
  }
}

loadAllPrdThreads();

// ─── Harness thread tracking ────────────────────────────────────────────────
interface HarnessThreadContext {
  channel: string;
  threadTs: string;
  repoId: string;
  lastRunId: string;
  lastWorkflow: string;
  history: string[];
}

const harnessThreads = new Map<string, HarnessThreadContext>();

function harnessThreadDir(repoId: string): string {
  return path.join(HUB_STATE_DIR, repoId, "harness-threads");
}

function saveHarnessThread(ctx: HarnessThreadContext): void {
  const key = `${ctx.channel}:${ctx.threadTs}`;
  harnessThreads.set(key, ctx);

  const dir = harnessThreadDir(ctx.repoId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = ctx.threadTs.replace(/\./g, "_");
  fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(ctx, null, 2));
}

function lookupHarnessThread(channel: string, threadTs: string): HarnessThreadContext | undefined {
  return harnessThreads.get(`${channel}:${threadTs}`);
}

function loadAllHarnessThreads(): void {
  if (!fs.existsSync(HUB_STATE_DIR)) return;
  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const dir = harnessThreadDir(repoId);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ctx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as HarnessThreadContext;
        harnessThreads.set(`${ctx.channel}:${ctx.threadTs}`, ctx);
      } catch {
        // skip corrupt files
      }
    }
  }
}

loadAllHarnessThreads();

// ─── Route-intent helper ────────────────────────────────────────────────────
interface RouteIntentResult {
  repoId: string | null;
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
  fallback: boolean;
}

async function routeIntent(prompt: string, repoId?: string): Promise<RouteIntentResult> {
  const body: Record<string, string> = { prompt };
  if (repoId) body.repoId = repoId;

  const res = await fetch(`${ZEVERSE_SERVER_URL}/api/route-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return zeverseResponseJson<RouteIntentResult>(res, "POST /api/route-intent");
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: !!process.env.SLACK_APP_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

// Log every incoming event for debugging.
app.use(async ({ payload, next, logger }) => {
  logger.info(
    `[incoming] type=${(payload as any).type ?? "?"} ` +
      `subtype=${(payload as any).subtype ?? "-"} ` +
      `text=${JSON.stringify((payload as any).text ?? "")}`
  );
  await next();
});

interface Repo {
  id: string;
  name: string;
}

async function listRepoIds(): Promise<Set<string>> {
  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/repos`);
    const data = await zeverseResponseJson<{ repos: Repo[] }>(res, "GET /api/repos");
    return new Set(data.repos.map((r) => r.id));
  } catch {
    return new Set();
  }
}

async function listWorkflowNames(repoId: string): Promise<Set<string>> {
  try {
    const res = await fetch(
      `${ZEVERSE_SERVER_URL}/api/workflows?repoId=${encodeURIComponent(repoId)}`
    );
    const data = await zeverseResponseJson<{ workflows: { name: string }[] }>(
      res,
      "GET /api/workflows"
    );
    return new Set((data.workflows ?? []).map((w) => w.name));
  } catch {
    return new Set();
  }
}

async function inferRepoIdFromPrompt(prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/infer-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await zeverseResponseJson<{ repoId: string | null; reason?: string }>(
      res,
      "POST /api/infer-repo"
    );
    return data.repoId ?? null;
  } catch {
    return null;
  }
}

async function inferWorkflowFromServer(repoId: string, prompt: string): Promise<string> {
  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/infer-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, prompt }),
    });
    const data = await zeverseResponseJson<{ workflow?: string }>(res, "POST /api/infer-workflow");
    if (typeof data.workflow === "string") return data.workflow;
  } catch {
    // fall through
  }
  try {
    const available = await listWorkflowNames(repoId);
    if (available.has(DEFAULT_WORKFLOW)) return DEFAULT_WORKFLOW;
    const first = available.values().next().value;
    return first ?? DEFAULT_WORKFLOW;
  } catch {
    return DEFAULT_WORKFLOW;
  }
}

// ─── Add-repo helpers ───────────────────────────────────────────────────────
// Read on each check so we always see the current process.env (and avoid stale
// values if the process loaded env in an unexpected order at startup).
function getRepoAdminUserIds(): Set<string> {
  return new Set(
    (process.env.ZEVERSE_REPO_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

interface AddRepoParseResult {
  url: string;
  name?: string;
}

function unwrapSlackUrl(raw: string): string {
  const m = raw.match(/^<([^|>]+)(?:\|[^>]*)?>$/);
  return m ? m[1] : raw;
}

function parseAddRepoCommand(stripped: string): AddRepoParseResult | null {
  const m = stripped.match(
    /^add-repo\s+(<[^>]+>|\S+)(?:\s+(\S+))?\s*$/i
  );
  if (!m) return null;
  const url = unwrapSlackUrl(m[1]);
  const name = m[2] || undefined;
  return { url, name };
}

interface CachedPolicy {
  allowed_slack_channels: string[];
  fetchedAt: number;
}

let policyCache: CachedPolicy | null = null;
const POLICY_CACHE_TTL_MS = 60_000;

async function fetchPolicyCached(): Promise<CachedPolicy> {
  if (policyCache && Date.now() - policyCache.fetchedAt < POLICY_CACHE_TTL_MS) {
    return policyCache;
  }
  try {
    const res = await fetch(`${zeverseBaseUrl()}/api/policy`);
    const data = await zeverseResponseJson<{
      allowed_repos: string[];
      allowed_workflows: string[];
      allowed_slack_channels: string[];
    }>(res, "GET /api/policy");
    policyCache = {
      allowed_slack_channels: data.allowed_slack_channels ?? ["*"],
      fetchedAt: Date.now(),
    };
  } catch {
    policyCache = { allowed_slack_channels: ["*"], fetchedAt: Date.now() };
  }
  return policyCache;
}

async function isRepoAdmin(
  slackUser: string,
  channel: string,
  isDm: boolean
): Promise<{ allowed: boolean; reason?: string }> {
  const admins = getRepoAdminUserIds();
  if (admins.size === 0) {
    return {
      allowed: false,
      reason:
        "`ZEVERSE_REPO_ADMIN_USER_IDS` is not configured. " +
        "Set it in the *repo root* `.env` as a comma-separated list of Slack user IDs, then restart the Slack bot process.",
    };
  }
  if (!admins.has(slackUser)) {
    return {
      allowed: false,
      reason: `User <@${slackUser}> is not in \`ZEVERSE_REPO_ADMIN_USER_IDS\`.`,
    };
  }
  if (!isDm) {
    const policy = await fetchPolicyCached();
    if (
      !policy.allowed_slack_channels.includes("*") &&
      !policy.allowed_slack_channels.includes(channel)
    ) {
      return {
        allowed: false,
        reason: `Channel \`${channel}\` is not in \`policy.allowed_slack_channels\`.`,
      };
    }
  }
  return { allowed: true };
}

interface AddRepoApiResult {
  id: string;
  name: string;
  origin: string;
  defaultBranch: string;
}

async function addRepoViaApi(
  input: AddRepoParseResult
): Promise<{ repo?: AddRepoApiResult; error?: string }> {
  try {
    const res = await fetch(`${zeverseBaseUrl()}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.url, name: input.name }),
    });
    if (!res.ok) {
      const data = await zeverseResponseJson<{ error?: string }>(res, "POST /api/repos");
      return { error: data.error ?? `HTTP ${res.status}` };
    }
    const data = await zeverseResponseJson<{ repo: AddRepoApiResult }>(
      res, "POST /api/repos"
    );
    return { repo: data.repo };
  } catch (err: any) {
    return { error: err.message };
  }
}

async function handleAddRepoMessage(
  rawText: string,
  channel: string,
  slackUser: string,
  threadTs: string,
  isDm: boolean,
  client: any,
  logger: any
): Promise<void> {
  const stripped = stripMentions(rawText);
  const parsed = parseAddRepoCommand(stripped);

  if (!parsed) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: [
        "*Usage*: `add-repo <git-url> [name]`",
        "Example: `@ZeverseBot add-repo https://github.com/org/my-repo.git`",
        "Example: `@ZeverseBot add-repo https://github.com/org/my-repo.git custom-name`",
      ].join("\n"),
    });
    return;
  }

  const auth = await isRepoAdmin(slackUser, channel, isDm);
  if (!auth.allowed) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `*Not authorized to add repos.*\n${auth.reason}`,
    });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `_Registering \`${parsed.url}\`..._`,
  });

  const result = await addRepoViaApi(parsed);

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `*Failed to add repo*\n${result.error}`,
    });
    return;
  }

  const repo = result.repo!;
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: [
      `*Repo added* :white_check_mark:`,
      `ID: \`${repo.id}\``,
      `Name: \`${repo.name}\``,
      `Origin: ${repo.origin}`,
      `Default branch: \`${repo.defaultBranch}\``,
      `<${ZEVERSE_UI_URL}|Open Zeverse>`,
    ].join("\n"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Repo added* :white_check_mark:`,
            `ID: \`${repo.id}\`  |  Name: \`${repo.name}\``,
            `Origin: ${repo.origin}`,
            `Default branch: \`${repo.defaultBranch}\``,
          ].join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Add rules & skills" },
            action_id: "bootstrap_rules",
            value: repo.id,
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open Zeverse" },
            url: ZEVERSE_UI_URL,
            action_id: "open_hub_link",
          },
        ],
      },
    ],
  });
}

interface RunResponse {
  runId?: string;
  error?: string;
}

async function triggerWorkflow(
  repoId: string,
  workflowName: string,
  prompt: string,
  inputs?: Record<string, string>
): Promise<RunResponse> {
  const res = await fetch(`${ZEVERSE_SERVER_URL}/api/run-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, workflow: workflowName, prompt, inputs }),
  });
  return zeverseResponseJson<RunResponse>(res, "POST /api/run-workflow");
}

interface Invocation {
  repoId: string | null;
  workflow: string;
  prompt: string;
}

// Strip leading <@UXXXX> mentions produced by Slack when the bot is tagged.
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface ParseOptions {
  explicitWorkflow?: string;
}

// Parse "[repo-id] [workflow] <prompt>" (order-flexible between repo / workflow).
// When repo or workflow aren't provided as leading tokens, infers them:
//   - repo: via LLM-based /api/infer-repo (or ZEVERSE_DEFAULT_REPO_ID env var)
//   - workflow: via keyword matching against available workflows (or explicitWorkflow override)
async function parseInvocation(rawText: string, opts: ParseOptions = {}): Promise<Invocation> {
  const text = stripMentions(rawText);
  if (!text) {
    return { repoId: DEFAULT_REPO_ID || null, workflow: opts.explicitWorkflow ?? DEFAULT_WORKFLOW, prompt: "" };
  }

  const tokens = text.split(/\s+/);
  const repos = await listRepoIds();

  let repoId: string | null = null;
  let workflow: string | null = null;
  let i = 0;

  for (let step = 0; step < 2 && i < tokens.length; step += 1) {
    const tok = tokens[i];
    if (!repoId && repos.has(tok)) {
      repoId = tok;
      i += 1;
      continue;
    }
    const candidateRepo = repoId ?? DEFAULT_REPO_ID;
    if (!workflow && candidateRepo) {
      const workflows = await listWorkflowNames(candidateRepo);
      if (workflows.has(tok)) {
        workflow = tok;
        i += 1;
        continue;
      }
    }
    break;
  }

  const prompt = tokens.slice(i).join(" ").trim();

  if (!repoId) {
    repoId = DEFAULT_REPO_ID || null;
  }
  if (!repoId) {
    repoId = await inferRepoIdFromPrompt(prompt || text);
  }

  if (opts.explicitWorkflow) {
    workflow = opts.explicitWorkflow;
  } else if (!workflow && repoId) {
    workflow = await inferWorkflowFromServer(repoId, prompt || text);
  }

  return {
    repoId,
    workflow: workflow ?? DEFAULT_WORKFLOW,
    prompt,
  };
}

function usageText(prefix: string): string {
  return [
    `*Usage*: ${prefix} [<repo-id>] [<workflow>] <your requirement>`,
    `• <repo-id> — optional; auto-inferred from your prompt`,
    `• <workflow> — optional; inferred via keywords (fallback: \`${DEFAULT_WORKFLOW}\`)`,
    `• Example: \`${prefix} ubx-ui pr-review fix flaky login test\``,
  ].join("\n");
}

async function noRepoErrorText(prefix: string): Promise<string> {
  const repos = await listRepoIds();
  const repoList = repos.size > 0
    ? `Available repos: ${[...repos].map((r) => `\`${r}\``).join(", ")}`
    : "No repos are currently registered.";
  return (
    `Could not determine which repo to use from your prompt.\n` +
    `${repoList}\n` +
    `Try: \`${prefix} <repo-id> <requirement>\``
  );
}

async function postSlashAnchor(
  client: any,
  channelId: string,
  text: string
): Promise<string> {
  const res = await client.chat.postMessage({ channel: channelId, text });
  return (res as any).ts ?? "";
}

interface RunState {
  runId: string;
  repoId: string;
  workflow?: string;
  status: string;
  steps: { id: string; status: string; output: string; error?: string }[];
  /** Git base branch used for the clone (when set on the run). */
  baseBranch?: string;
  /** Isolation / run branch when using branch workflow isolation. */
  branch?: string;
  /** Present when the run failed due to gate rules (no step may be marked `failed`). */
  gateFailures?: { stepId: string; error: string }[];
}

/**
 * The server can mark a run `failed` without any step in `status: "failed"`
 * (e.g. LLM init, git isolation, branch creation, or gate checks). The UI shows
 * logs; Slack used to only show "Step: ? / Error: unknown" — this surfaces real reasons.
 */
async function formatRunFailureForSlack(
  title: string,
  runId: string,
  repoId: string,
  state: RunState
): Promise<string> {
  const failedStep = state.steps.find((s) => s.status === "failed");
  const hubLink = `<${ZEVERSE_UI_URL}/?run=${runId}|View run details>`;
  const branchNote = (state.baseBranch ?? state.branch ?? "").trim();
  const branchLine = branchNote ? `Branch: \`${branchNote}\`` : "";

  if (failedStep) {
    const errMsg = sanitizeForSlackMrkdwn((failedStep.error ?? "unknown").trim());
    return [
      `*${title}*`,
      branchLine,
      `Step: \`${failedStep.id}\``,
      `Error: ${errMsg}`,
      hubLink,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lines: string[] = [`*${title}*`];
  if (branchLine) lines.push(branchLine);
  if (state.gateFailures && state.gateFailures.length > 0) {
    lines.push("*Gate check:*", "");
    state.gateFailures.forEach((g, i) => {
      lines.push(`${i + 1}. \`${g.stepId}\`: ${sanitizeForSlackMrkdwn((g.error ?? "").trim())}`);
    });
  } else {
    lines.push(
      "_No step-level error on record._ Common causes: *LLM init* (check `config/zeverse.yaml` and env), *git isolation* (uncommitted changes on the server’s repo copy), or *branch creation* failed. *Log tail* or the Zeverse run view has the line that explains it."
    );
  }

  let tail = "";
  try {
    const res = await fetch(
      `${zeverseBaseUrl()}/api/logs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}&offset=0`
    );
    if (res.ok) {
      const data = await zeverseResponseJson<{ content?: string }>(res, "GET /api/logs");
      const t = (data.content ?? "").trim();
      if (t.length > 0) {
        const slice = t.length > 1800 ? t.slice(-1800) : t;
        tail = `\n*Log tail:*\n\`\`\`\n${slice}\n\`\`\``;
      }
    }
  } catch {
    // best-effort
  }

  return `${lines.join("\n")}${tail}\n${hubLink}`;
}

/** Markdown body under a `## Summary` heading (same rule as server `extractFrAnalysisSummarySection`). */
function extractFrAnalysisSummaryForSlack(text: string): string | null {
  const m = text.match(/^##\s*Summary\s*$/m);
  if (m == null || m.index === undefined) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^##\s+\S/m);
  const block = (next === -1 ? after : after.slice(0, next)).trim();
  return block || null;
}

const SLACK_MAX_TEXT = 3900;
/** Slack `section` mrkdwn fields are capped smaller than our plain `text` fallback. */
const SLACK_SECTION_MRDKWN_MAX = 2900;

/** Friendlier thread headers when a run finishes (fallback: “Workflow complete”). */
const WORKFLOW_SLACK_LABELS: Record<string, string> = {
  "fr-analyze": "Done — Freshrelease analysis",
  "prd-analysis": "Done — PRD analysis",
  dev: "Done — dev workflow",
  "pr-review": "Done — PR review",
  test: "Done — test run",
};

function trimOutput(text: string): string {
  if (text.length <= SLACK_MAX_TEXT) return text;
  return text.slice(0, SLACK_MAX_TEXT) + "\n…_(truncated — see full output in Zeverse)_";
}

function trimSlackMrkdwnSection(text: string, max = SLACK_SECTION_MRDKWN_MAX): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max - 55).trimEnd() +
    "\n…_(truncated — open thread fallback or Zeverse for full text)_"
  );
}

async function pollRunAndPostResult(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await zeverseResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("Workflow failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const checkoutBranchForRun = (state.baseBranch ?? state.branch ?? "").trim();

    const wfName = state.workflow ?? "";
    const doneTitle = WORKFLOW_SLACK_LABELS[wfName] ?? "Workflow complete";
    const jestRawForTest =
      wfName === "test" ? findStepOutputWithJestSummary(state.steps) : null;
    const jestParsedForTest =
      wfName === "test"
        ? extractJestSummary(jestRawForTest ?? "")
        : extractJestSummary("");
    const sectionParts: string[] = [];

    const diffStep = state.steps.find((s) => s.id === "diff-after");
    if (diffStep?.output) {
      const diffLines = diffStep.output.split("\n");
      const statLine = diffLines.find((l) => l.includes("files changed") || l.includes("file changed"));
      if (statLine) sectionParts.push(`\`${statLine.trim()}\``);
      const diffPreview = diffLines
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 20)
        .join("\n");
      if (diffPreview) sectionParts.push("```" + diffPreview + "```");
    }

    const prStep = state.steps.find((s) => s.id === "open-pr");
    if (prStep?.output) {
      const prUrlMatch = prStep.output.match(/PR_URL=(https?:\/\/\S+)/);
      if (prUrlMatch) sectionParts.push(`<${prUrlMatch[1]}|View PR on GitHub>`);
    }

    const reviewStep = state.steps.find((s) => s.id === "review");
    if (reviewStep?.output) {
      const verdictMatch = reviewStep.output.match(/(?:verdict|recommendation)[:\s]*(.*)/i);
      if (verdictMatch) {
        const v = sanitizeForSlackMrkdwn(verdictMatch[1].trim().slice(0, 200));
        sectionParts.push(`*Review verdict:* ${v}`);
      }
    }

    const hasDiffPrReview =
      !!(diffStep?.output || prStep?.output || reviewStep?.output);
    if (!hasDiffPrReview) {
      if (wfName === "fr-analyze") {
        const analyse = state.steps.find((s) => s.id === "analyse");
        const raw = analyse?.output ?? "";
        const summary = extractFrAnalysisSummaryForSlack(raw);
        const formatted = formatLLMTextForSlack(summary ?? raw);
        sectionParts.push(formatted);
      } else {
        const lastStep = state.steps[state.steps.length - 1];
        const lastOutput = lastStep?.output ?? "";
        let formatted = formatLLMTextForSlack(lastOutput);
        if (wfName === "test" || wfName === "test-fix") {
          const branchLine = checkoutBranchForRun
            ? `*Branch:* \`${checkoutBranchForRun}\``
            : "";
          if (wfName === "test") {
            const header = formatJestStatusHeader(state.status, jestParsedForTest);
            formatted = [branchLine, header, formatted].filter(Boolean).join("\n\n");
          } else {
            formatted = [branchLine, formatted].filter(Boolean).join("\n\n");
          }
        }
        sectionParts.push(formatted);
      }
    }

    const bodyCore = sectionParts.filter(Boolean).join("\n\n");
    const bodyTrimmed = trimOutput(bodyCore);
    const footer = `<${ZEVERSE_UI_URL}/?run=${runId}|View full output in Zeverse>`;
    const text = wrapWorkflowSummary({
      title: doneTitle,
      body: bodyTrimmed,
      footer,
    });

    const showFixButton =
      wfName === "test" && jestSummaryHasFailures(jestParsedForTest);

    if (showFixButton) {
      await client.chat.postMessage({
        channel,
        thread_ts,
        text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: trimSlackMrkdwnSection(text),
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Fix failing tests" },
                action_id: "test_run_fix_failing",
                value: `${repoId}:${runId}`,
              },
            ],
          },
        ],
      });
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts,
        text,
      });
    }
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*Workflow timed out* — the run is still going.\n` +
      `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
  });
}

function successBlocks(
  inv: Invocation & { runId: string },
  opts?: { branchLine?: string }
): any[] {
  const core = [
    `*Zeverse workflow started*`,
    `Repo: \`${inv.repoId}\``,
    `Workflow: \`${inv.workflow}\``,
  ];
  if (opts?.branchLine?.trim()) core.push(opts.branchLine.trim());
  core.push(
    `Prompt: ${inv.prompt}`,
    `Run ID: \`${inv.runId}\``,
    `<${ZEVERSE_UI_URL}/?run=${inv.runId}|View in Zeverse>`
  );
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: core.join("\n"),
      },
    },
  ];
}

function registerCommand(commandName: string, workflowName: string) {
  app.command(commandName, async ({ command, ack, respond, client, logger }) => {
    await ack();

    const inv = await parseInvocation(command.text ?? "", { explicitWorkflow: workflowName });

    if (!inv.prompt) {
      await respond({ response_type: "ephemeral", text: usageText(commandName) });
      return;
    }
    if (!inv.repoId) {
      await respond({
        response_type: "ephemeral",
        text: await noRepoErrorText(commandName),
      });
      return;
    }

    try {
      const result = await triggerWorkflow(inv.repoId, inv.workflow, inv.prompt);
      if (result.error) {
        await respond({
          response_type: "ephemeral",
          text: `Failed to start workflow: ${result.error}`,
        });
        return;
      }
      const runId = result.runId ?? "";
      const rootTs = await postSlashAnchor(
        client,
        command.channel_id,
        [
          `*Zeverse workflow started*`,
          `Repo: \`${inv.repoId}\``,
          `Workflow: \`${inv.workflow}\``,
          `Prompt: ${inv.prompt}`,
          `Run ID: \`${runId}\``,
          `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
        ].join("\n")
      );

      pollRunAndPostResult(runId, inv.repoId, command.channel_id, rootTs, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult error:", err)
      );
    } catch (err: any) {
      await respond({
        response_type: "ephemeral",
        text: `Error connecting to Zeverse server: ${err.message}`,
      });
    }
  });
}

registerCommand("/zeverse-dev", "dev");
registerCommand("/zeverse-fr-analyze", "fr-analyze");
// ─── /zeverse-harness (smart router) ─────────────────────────────────────────
app.command("/zeverse-harness", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const rawText = command.text ?? "";
  const parsed = await parseInvocation(rawText);
  const prompt = parsed.prompt || rawText.trim();

  if (!prompt) {
    await respond({
      response_type: "ephemeral",
      text: [
        `*Usage*: \`/zeverse-harness <anything>\``,
        `Ask a question, describe a bug, request a feature, ask for a review — the router picks the right workflow.`,
        `Example: \`/zeverse-harness fix the login redirect loop\``,
        `Example: \`/zeverse-harness how does the billing page work?\``,
      ].join("\n"),
    });
    return;
  }

  const repoId = parsed.repoId || DEFAULT_REPO_ID || null;

  const rootTs = await postSlashAnchor(
    client,
    command.channel_id,
    `_Thinking... routing your request to the best workflow._`
  );

  handleHarnessMessage(prompt, command.channel_id, rootTs, client, logger, "slash", repoId).catch(
    (err) => logger.error("handleHarnessMessage (slash) error:", err)
  );
});

// ─── /zeverse-add-repo (register a repo from Slack) ─────────────────────────
app.command("/zeverse-add-repo", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const rawText = (command.text ?? "").trim();
  if (!rawText) {
    await respond({
      response_type: "ephemeral",
      text: [
        "*Usage*: `/zeverse-add-repo <git-url> [name]`",
        "Example: `/zeverse-add-repo https://github.com/org/my-repo.git`",
        "Example: `/zeverse-add-repo https://github.com/org/my-repo.git custom-name`",
      ].join("\n"),
    });
    return;
  }

  const rootTs = await postSlashAnchor(
    client,
    command.channel_id,
    `_Registering repo..._`
  );
  await handleAddRepoMessage(
    `add-repo ${rawText}`,
    command.channel_id,
    command.user_id,
    rootTs,
    false,
    client,
    logger
  );
});

// ─── /zeverse-prd (PRD analysis) ────────────────────────────────────────────

function isGoogleDocUrl(text: string): boolean {
  return /docs\.google\.com\/document\/d\//.test(text) ||
    /drive\.google\.com\/.*\/d\//.test(text);
}

const CONFLUENCE_URL_RE =
  /(?:atlassian\.net\/wiki\/|confluence\.|\/display\/|\/spaces\/[^/]+\/pages\/|\/pages\/viewpage\.action)/i;

function isConfluenceUrl(text: string): boolean {
  return CONFLUENCE_URL_RE.test(text);
}

function isPrdDocUrl(text: string): boolean {
  return isGoogleDocUrl(text) || isConfluenceUrl(text);
}

function extractSlackReply(text: string): string | null {
  const m = text.match(/---\s*SLACK REPLY\s*---\s*\n([\s\S]*?)\n---\s*END SLACK REPLY\s*---/);
  return m ? m[1].trim() : null;
}

function extractEpicBreakdown(text: string): string | null {
  const m = text.match(/---\s*EPIC BREAKDOWN\s*---\s*\n([\s\S]*?)\n---\s*END EPIC BREAKDOWN\s*---/);
  return m ? m[1].trim() : null;
}

function extractQueriesJson(text: string): { anchor?: string; body: string; severity: QuerySeverity }[] {
  const re = /```(?:json)?\s*queries?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e: any) => typeof e === "object" && typeof e.body === "string")
      .map((e: any) => ({
        anchor: e.anchor as string | undefined,
        body: e.body as string,
        severity: (e.severity === "critical" ? "critical" : "nice-to-have") as QuerySeverity,
      }));
  } catch {
    return [];
  }
}

/**
 * Parses the post-queries step output to extract query index -> commentId.
 * Lines look like: `+ [3] some text (id=ABcd1234)`
 */
function parsePostedCommentIds(output: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /^\+\s*\[(\d+)\].*\(id=([^)]+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    map.set(parseInt(m[1], 10), m[2]);
  }
  return map;
}

function extractDocId(urlOrId: string): string {
  const trimmed = urlOrId.trim().replace(/^<|>$/g, "");
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return trimmed;
}

// ─── PRD context discovery ──────────────────────────────────────────────────
// When no saved PRD thread context exists (e.g. because the slash command
// didn't save one properly), discover it by scanning the thread for an
// Zeverse run URL and reconstructing the context from the run state.

/**
 * Scans local run state files to find the most recent successful prd-analysis
 * run and reconstructs a PrdThreadContext from it. This avoids needing Slack
 * API scopes just for discovery.
 */
function discoverPrdContextFromState(
  channel: string,
  threadTs: string,
  logger: any
): PrdThreadContext | undefined {
  if (!fs.existsSync(HUB_STATE_DIR)) return undefined;

  let bestRun: { repoId: string; data: any; mtime: number } | undefined;

  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const runsDir = path.join(HUB_STATE_DIR, repoId, "runs");
    if (!fs.existsSync(runsDir)) continue;

    for (const file of fs.readdirSync(runsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(runsDir, file);
        const stat = fs.statSync(filePath);
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (data.workflow !== "prd-analysis" || data.status !== "success") continue;
        if (!bestRun || stat.mtimeMs > bestRun.mtime) {
          bestRun = { repoId, data, mtime: stat.mtimeMs };
        }
      } catch {
        // skip corrupt files
      }
    }
  }

  if (!bestRun) {
    logger.info("discoverPrdContextFromState: no successful prd-analysis runs found");
    return undefined;
  }

  const state = bestRun.data;
  const repoId = bestRun.repoId;

  // Extract doc URL from the prompt
  let docUrl = "";
  const promptMatch = (state.prompt ?? "").match(
    /(https?:\/\/docs\.google\.com\/document\/d\/[^\s]+)/
  );
  if (promptMatch) docUrl = promptMatch[1];
  if (!docUrl) return undefined;

  const analyseStep = (state.steps ?? []).find((s: any) => s.id === "analyse");
  const postQueriesStep = (state.steps ?? []).find((s: any) => s.id === "post-queries");

  const analyseOutput = analyseStep?.output ?? "";
  const commentSummary = postQueriesStep?.output ?? "";

  const queries = extractQueriesJson(analyseOutput);
  const commentIds = parsePostedCommentIds(commentSummary);

  const trackedQueries: PrdQueryInfo[] = queries.map((q, idx) => ({
    index: idx + 1,
    body: q.body,
    anchor: q.anchor ?? "",
    commentId: commentIds.get(idx + 1) ?? "",
    severity: q.severity,
  }));

  const ctx: PrdThreadContext = {
    channel,
    threadTs: threadTs,
    repoId,
    docUrl,
    docId: extractDocId(docUrl),
    runId: state.runId ?? "",
    queries: trackedQueries,
  };

  savePrdThread(ctx);
  logger.info(
    `discoverPrdContextFromState: reconstructed from run ${ctx.runId} ` +
    `(${trackedQueries.length} queries, doc=${ctx.docId})`
  );

  return ctx;
}

// ─── Shared thread-context builder ──────────────────────────────────────────
// Formats Slack thread messages into a structured text block that can be
// passed to workflows as the `threadContext` input.

function buildThreadContext(
  messages: any[],
  queries: PrdQueryInfo[]
): string {
  const humanReplies = messages.slice(1).filter(
    (msg: any) => !msg.bot_id && !msg.subtype
  );
  if (humanReplies.length === 0) return "";

  const lines: string[] = ["--- PRIOR SLACK DISCUSSION ---"];
  for (const q of queries) {
    lines.push(`Q${q.index}: ${q.body}`);
    const answers = humanReplies.filter((msg: any) => {
      const t = (msg.text ?? "").trim();
      const prefix = t.match(/^(?:Q|#)\s*(\d+)\b/i);
      return prefix && parseInt(prefix[1], 10) === q.index;
    });
    if (answers.length > 0) {
      for (const a of answers) {
        const user = a.user ?? "unknown";
        const ansText = (a.text ?? "").replace(/^(?:Q|#)\s*\d+[:\s]*/i, "").trim();
        lines.push(`  A (user: ${user}): ${ansText}`);
      }
    } else {
      lines.push("  (no answers yet)");
    }
  }
  const unmatchedReplies = humanReplies.filter((msg: any) => {
    const t = (msg.text ?? "").trim();
    return !t.match(/^(?:Q|#)\s*\d+\b/i);
  });
  if (unmatchedReplies.length > 0) {
    lines.push("");
    lines.push("General discussion:");
    for (const a of unmatchedReplies) {
      lines.push(`  (user: ${a.user ?? "unknown"}): ${(a.text ?? "").trim()}`);
    }
  }
  lines.push("--- END PRIOR SLACK DISCUSSION ---");
  return lines.join("\n");
}

async function pollRunAndReply(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  docUrl: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200; // ~10 min at 3s intervals
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await zeverseResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("PRD analysis failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const analyseStep = state.steps.find((s) => s.id === "analyse");
    const postQueriesStep = state.steps.find((s) => s.id === "post-queries");

    const analyseOutput = analyseStep?.output ?? "";
    const slackReply = extractSlackReply(analyseOutput);
    const epicBreakdown = extractEpicBreakdown(analyseOutput);
    const commentSummary = postQueriesStep?.output ?? "";

    const queries = extractQueriesJson(analyseOutput);
    const commentIds = parsePostedCommentIds(commentSummary);
    const trackedQueries: PrdQueryInfo[] = queries.map((q, idx) => ({
      index: idx + 1,
      body: q.body,
      anchor: q.anchor ?? "",
      commentId: commentIds.get(idx + 1) ?? "",
      severity: q.severity,
    }));
    const docId = extractDocId(docUrl);

    const openTotal = trackedQueries.length;
    const criticalCount = trackedQueries.filter((q) => q.severity === "critical").length;

    const postedMatch = commentSummary.match(/Posted (\d+)\/(\d+) comments/);
    const skippedMatch = commentSummary.match(/(\d+) skipped as duplicates/);
    const commentLine = postedMatch
      ? `Posted ${postedMatch[1]} of ${postedMatch[2]} comments on the Google Doc` +
        (skippedMatch ? ` (${skippedMatch[1]} skipped as duplicates)` : "")
      : "";

    const questionCountLine = openTotal > 0
      ? `*Open questions:* ${openTotal}${criticalCount > 0 ? ` (${criticalCount} critical)` : ""}`
      : "";

    const slackReplyFmt = slackReply
      ? formatLLMTextForSlack(slackReply)
      : "_No verdict produced — check the full run._";
    const epicFmt = epicBreakdown
      ? formatLLMTextForSlack(epicBreakdown)
      : "";

    const body = [
      `*PRD analysis complete* — here’s the summary for \`${repoId}\`.`,
      "",
      slackReplyFmt,
      "",
      commentLine,
      questionCountLine,
      `<${docUrl}|Open PRD in Google Docs>  |  <${ZEVERSE_UI_URL}/?run=${runId}|View full analysis in Zeverse>`,
      "",
      epicFmt ? `*Epic & tasks*\n${epicFmt}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await client.chat.postMessage({ channel, thread_ts, text: body });

    // Post each critical question as a separate block with an owner picker
    const criticalQueries = trackedQueries.filter((q) => q.severity === "critical");
    for (const q of criticalQueries) {
      const gdocLink = q.commentId
        ? `<https://docs.google.com/document/d/${docId}/edit?disco=${q.commentId}|View in GDoc>`
        : "";
      const qBodyFmt = sanitizeForSlackMrkdwn(q.body);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `[Q${q.index}] ${qBodyFmt}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*[Q${q.index}]* ${qBodyFmt}${gdocLink ? `\n${gdocLink}` : ""}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "users_select",
                placeholder: { type: "plain_text", text: "Assign owner..." },
                action_id: "prd_assign_owner",
              },
            ],
            block_id: `prd_assign_${runId}_${q.index}`,
          },
        ],
        metadata: {
          event_type: "prd_assign_context",
          event_payload: { runId, repoId, channel, threadTs: thread_ts, queryIndex: q.index, docId },
        },
      });
    }

    // Always post "Raise PR" / "Create FR Card" / "Cancel" confirmation buttons
    const deliverableStep = state.steps.find((s) => s.id === "deliverable");
    const prdPrId = storePrdPrProposal({
      repoId,
      runId,
      channel,
      threadTs: thread_ts,
      docUrl,
    });
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: "Click *Raise PR* to open a pull request, or *Create FR Card* to create Freshrelease cards from the deliverable.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: deliverableStep?.output
              ? "_The PRD analysis deliverable is ready. Click *Raise PR* to open a pull request, or *Create FR Card* to create Freshrelease cards._"
              : "_Click *Raise PR* to open a pull request. Note: the deliverable step produced no output — the PR/cards may be empty._",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Raise PR" },
              style: "primary",
              action_id: "prd_confirm_pr",
              value: prdPrId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Create FR Card" },
              action_id: "prd_create_fr_card",
              value: prdPrId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Cancel" },
              action_id: "prd_cancel_pr",
              value: prdPrId,
            },
          ],
        },
      ],
    });

    // Save thread context for reply handling and re-run detection
    try {
      if (trackedQueries.length > 0) {
        savePrdThread({
          channel,
          threadTs: thread_ts,
          repoId,
          docUrl,
          docId,
          runId,
          queries: trackedQueries,
        });
      }
    } catch {
      // non-critical — don't break the flow
    }

    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD analysis timed out* — the run is still going.\n` +
      `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
  });
}

app.command("/zeverse-prd", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const inv = await parseInvocation(command.text ?? "");
  inv.workflow = "prd-analysis";

  // For /zeverse-prd the "prompt" is actually the Google Doc URL.
  const docUrl = inv.prompt;

  if (!docUrl) {
    await respond({
      response_type: "ephemeral",
      text: [
        `*Usage*: \`/zeverse-prd [<repo-id>] <doc-url>\``,
        `• <repo-id> — optional; defaults to \`ZEVERSE_DEFAULT_REPO_ID\``,
        `• Supports Google Docs and Confluence (Server/DC) URLs`,
        `• Example: \`/zeverse-prd ubx-ui https://docs.google.com/document/d/1abc.../edit\``,
        `• Example: \`/zeverse-prd ubx-ui https://confluence.example.com/spaces/TEAM/pages/12345/My+PRD\``,
      ].join("\n"),
    });
    return;
  }

  if (!isPrdDocUrl(docUrl)) {
    await respond({
      response_type: "ephemeral",
      text: `That doesn't look like a supported document URL. Expected a Google Docs URL (\`https://docs.google.com/document/d/...\`) or a Confluence page URL.`,
    });
    return;
  }

  if (!inv.repoId) {
    await respond({
      response_type: "ephemeral",
      text: await noRepoErrorText("/zeverse-prd"),
    });
    return;
  }

  try {
    // Collect prior Slack thread discussion for re-runs
    let threadContext = "";
    const priorThreads = lookupPrdThreadsByDocUrl(docUrl);
    if (priorThreads.length > 0) {
      try {
        const latest = priorThreads[priorThreads.length - 1];
        const threadRes = await client.conversations.replies({
          channel: latest.channel,
          ts: latest.threadTs,
          limit: 200,
        });
        const messages = (threadRes.messages ?? []) as any[];
        threadContext = buildThreadContext(messages, latest.queries);
      } catch (err: any) {
        logger.error(`Failed to collect thread history: ${err.message}`);
      }
    }

    const inputs: Record<string, string> = { docUrl };
    if (threadContext) inputs.threadContext = threadContext;

    const result = await triggerWorkflow(
      inv.repoId,
      inv.workflow,
      `PRD analysis for ${docUrl}`,
      inputs
    );

    if (result.error) {
      await respond({
        response_type: "ephemeral",
        text: `Failed to start PRD analysis: ${result.error}`,
      });
      return;
    }

    const runId = result.runId ?? "";
    const rerunNote = threadContext
      ? `\n_Re-run detected — incorporating ${priorThreads.length} prior thread(s)._`
      : "";

    const rootTs = await postSlashAnchor(
      client,
      command.channel_id,
      `*PRD analysis started* on \`${inv.repoId}\` for <${docUrl}|Open PRD>\n` +
        `Run: \`${runId}\` | <${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>\n` +
        `_I'll reply in this thread when the analysis is done._` +
        rerunNote
    );

    pollRunAndReply(
      runId,
      inv.repoId,
      command.channel_id,
      rootTs,
      docUrl,
      client,
      logger
    ).catch((err) => logger.error("pollRunAndReply error:", err));
  } catch (err: any) {
    await respond({
      response_type: "ephemeral",
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
  }
});

// ─── PRD thread @mention handling ───────────────────────────────────────────
// When the bot is @mentioned inside a tracked PRD thread with an "update" or
// "answer" intent, read the thread history and sync back to the Google Doc.

type PrdMentionIntent = "update" | "answer";

const UPDATE_RE = /^(update|edit|apply|update\s+(the\s+)?(prd|doc|prd\s+doc))$/i;
const ANSWER_RE = /^(answer|answer\s+this|reply|respond|post\s+answers|ans\s+this)$/i;

function parsePrdMentionIntent(stripped: string): PrdMentionIntent | null {
  if (UPDATE_RE.test(stripped)) return "update";
  if (ANSWER_RE.test(stripped)) return "answer";
  return null;
}

function extractAnswersJson(text: string): { queryIndex: number; commentId: string; body: string }[] {
  const re = /```(?:json)?\s*answers?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((e: any) => e.queryIndex && e.body) : [];
  } catch {
    return [];
  }
}

function extractSummaryBlock(text: string): string | null {
  const m = text.match(/---\s*SUMMARY\s*---\s*\n([\s\S]*?)\n---\s*END SUMMARY\s*---/);
  return m ? m[1].trim() : null;
}

function extractEditsJson(text: string): { anchor: string; replacement: string; reason: string }[] {
  const re = /```(?:json)?\s*edits?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((e: any) => e.anchor && e.replacement) : [];
  } catch {
    return [];
  }
}

async function postGDocComment(
  docId: string,
  body: string,
  anchor?: string
): Promise<{ commentId?: string; error?: string }> {
  try {
    const payload: { docId: string; body: string; anchor?: string } = {
      docId,
      body,
    };
    const trimmed = anchor?.trim();
    if (trimmed) payload.anchor = trimmed;
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/gdoc-comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await zeverseResponseJson<{ commentId?: string; error?: string }>(
      res,
      "POST /api/gdoc-comment"
    );
  } catch (err: any) {
    return { error: err.message };
  }
}

async function postGDocSuggestEdits(
  docId: string,
  edits: { anchor: string; replacement: string }[]
): Promise<{ applied?: number; skipped?: { anchor: string; reason: string }[]; error?: string }> {
  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/gdoc-suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, edits }),
    });
    return await zeverseResponseJson<any>(res, "POST /api/gdoc-suggest");
  } catch (err: any) {
    return { error: err.message };
  }
}

async function handlePrdThreadMention(
  ctx: PrdThreadContext,
  intent: PrdMentionIntent,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD ${intent === "update" ? "update" : "answer sync"} started*\n` +
      `Reading thread history and syncing to <${ctx.docUrl}|Google Doc>...\n` +
      `_I'll reply here when done._`,
  });

  let threadContext = "";
  try {
    const threadRes = await client.conversations.replies({
      channel,
      ts: thread_ts,
      limit: 200,
    });
    const messages = (threadRes.messages ?? []) as any[];
    threadContext = buildThreadContext(messages, ctx.queries);
  } catch (err: any) {
    logger.error(`Failed to collect thread history: ${err.message}`);
    const scopeHint = err.message?.includes("missing_scope")
      ? `\n_The Slack app is missing the \`groups:history\` scope. ` +
        `Add it in your Slack app settings under OAuth & Permissions._`
      : "";
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Failed to read thread history: ${err.message}${scopeHint}`,
    });
    return;
  }

  if (!threadContext) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `No discussion found in this thread to sync.`,
    });
    return;
  }

  let result: RunResponse;
  try {
    result = await triggerWorkflow(ctx.repoId, "prd-thread-sync", `PRD thread sync (${intent})`, {
      docUrl: ctx.docUrl,
      intent,
      threadContext,
      queries: JSON.stringify(ctx.queries),
    });
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
    return;
  }

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Failed to start PRD thread sync: ${result.error}`,
    });
    return;
  }

  const runId = result.runId ?? "";

  pollThreadSync(runId, ctx, intent, channel, thread_ts, client, logger).catch((err) =>
    logger.error("pollThreadSync error:", err)
  );
}

async function pollThreadSync(
  runId: string,
  ctx: PrdThreadContext,
  intent: PrdMentionIntent,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(ctx.repoId)}`
      );
      state = await zeverseResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("PRD thread sync failed", runId, ctx.repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const synthesizeStep = state.steps.find((s) => s.id === "synthesize");
    const output = synthesizeStep?.output ?? "";

    const answers = extractAnswersJson(output);
    const summary = extractSummaryBlock(output);
    const edits = intent === "update" ? extractEditsJson(output) : [];

    let repliesPosted = 0;
    let repliesFailed = 0;
    for (const ans of answers) {
      if (!ans.commentId) continue;
      const r = await postGDocReply(ctx.docId, ans.commentId, ans.body);
      if (r.error) {
        repliesFailed++;
        logger.error(`GDoc reply failed for Q${ans.queryIndex}: ${r.error}`);
      } else {
        repliesPosted++;
      }
    }

    let editsApplied = 0;
    let editsSkipped = 0;
    if (edits.length > 0) {
      const r = await postGDocSuggestEdits(ctx.docId, edits);
      if (r.error) {
        logger.error(`GDoc suggest edits failed: ${r.error}`);
      } else {
        editsApplied = r.applied ?? 0;
        editsSkipped = (r.skipped ?? []).length;
      }
    }

    const verb = intent === "update" ? "update" : "answer";
    const parts: string[] = [
      `*PRD ${verb} sync finished* — I’ve pushed your thread back to the doc on \`${ctx.repoId}\`.`,
      "",
    ];
    let syncLine = 0;
    if (repliesPosted > 0) parts.push(`${++syncLine}. Replies posted on Google Doc comments: ${repliesPosted}`);
    if (repliesFailed > 0) parts.push(`${++syncLine}. Reply failures: ${repliesFailed}`);
    if (intent === "update" && edits.length > 0) {
      parts.push(`${++syncLine}. Suggestions created: ${editsApplied}, skipped: ${editsSkipped}`);
    }
    if (repliesPosted === 0 && repliesFailed === 0 && !(intent === "update" && edits.length > 0)) {
      parts.push("_No comment replies were posted (see the Zeverse run for details)._");
    }
    if (summary?.trim()) {
      parts.push("");
      parts.push(formatLLMTextForSlack(summary));
    }
    parts.push("");
    parts.push(`<${ctx.docUrl}|Open PRD in Google Docs>`);
    parts.push(`<${ZEVERSE_UI_URL}/?run=${runId}|View full run in Zeverse>`);

    await client.chat.postMessage({ channel, thread_ts, text: parts.join("\n") });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD thread sync timed out* — the run is still going.\n` +
      `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
  });
}

// ─── Generic thread context helpers ─────────────────────────────────────────

async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  client: any
): Promise<any[]> {
  try {
    const threadRes = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
    });
    return (threadRes.messages ?? []) as any[];
  } catch {
    return [];
  }
}

function buildGenericThreadContext(messages: any[]): string {
  if (messages.length <= 1) return "";
  const lines: string[] = ["--- PRIOR THREAD DISCUSSION ---"];
  for (const msg of messages.slice(0, -1)) {
    const who = msg.bot_id ? "bot" : `user:${msg.user ?? "unknown"}`;
    lines.push(`[${who}] ${(msg.text ?? "").trim()}`);
  }
  lines.push("--- END PRIOR THREAD DISCUSSION ---");
  return lines.join("\n");
}

// ─── Harness route + execute callers ────────────────────────────────────────

interface HarnessRouteResult {
  type: "proposal" | "answer" | "answer_with_proposal" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  suggestions?: {
    workflow: string;
    inputs: Record<string, string>;
    confidence: number;
    reason: string;
  }[];
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  clarifyingQuestion?: string;
  missing?: string[];
  prdThreadMatch?: {
    queryIndex: number | null;
    suggestion: string | null;
    conversationalReply?: string;
    noMatchExplanation?: string;
  };
  /** Populated on some error responses (e.g. HTTP 500 from harness/route). */
  error?: string;
}

function formatHarnessAnswerForSlack(raw: string): string {
  const body = formatLLMTextForSlack(raw);
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    return wrapWorkflowSummary({
      title: "Here's what I found",
      body,
    });
  }
  return body;
}

async function callHarnessRoute(
  prompt: string,
  threadContext: string,
  repoId: string | null,
  surface: string,
  extras?: { prdQueries?: { index: number; body: string }[] }
): Promise<HarnessRouteResult> {
  const body: Record<string, any> = { prompt, surface };
  if (threadContext) body.threadContext = threadContext;
  if (repoId) body.repoId = repoId;
  if (extras?.prdQueries?.length) body.prdQueries = extras.prdQueries;

  const res = await fetch(`${ZEVERSE_SERVER_URL}/api/harness/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return zeverseResponseJson<HarnessRouteResult>(res, "POST /api/harness/route");
}

interface ExecuteOptions {
  slackUser?: string;
  channel?: string;
  surface?: string;
  baseBranch?: string;
  threadContext?: string;
}

async function callHarnessExecute(
  repoId: string,
  workflow: string,
  inputs: Record<string, string>,
  prompt: string,
  opts: ExecuteOptions = {}
): Promise<RunResponse & { missing?: string[] }> {
  const body: Record<string, any> = {
    repoId, workflow, inputs, prompt,
    slackUser: opts.slackUser,
    channel: opts.channel,
    surface: opts.surface,
  };
  if (opts.baseBranch) body.baseBranch = opts.baseBranch;
  if (opts.threadContext?.trim()) body.threadContext = opts.threadContext.trim();

  const res = await fetch(`${ZEVERSE_SERVER_URL}/api/harness/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return zeverseResponseJson<RunResponse & { missing?: string[] }>(res, "POST /api/harness/execute");
}

/**
 * Extract branch targeting from a Slack message (aligned with server extractBranchHint)
 * and return the cleaned prompt plus optional HTTP baseBranch for execute.
 */
function extractBranchFlag(text: string): { prompt: string; baseBranch?: string } {
  const eq = text.match(/\bbranch=(\S+)/i);
  if (eq) {
    return {
      prompt: text.replace(eq[0], "").trim(),
      baseBranch: eq[1],
    };
  }
  const branchWord = text.match(/\bbranch\s+([\w./-]+)\b/i);
  if (branchWord) {
    return {
      prompt: text.replace(branchWord[0], "").trim(),
      baseBranch: branchWord[1],
    };
  }
  const onBranch = text.match(/\bon\s+(?:the\s+)?branch\s+([\w./-]+)\b/i);
  if (onBranch) {
    return {
      prompt: text.replace(onBranch[0], "").trim(),
      baseBranch: onBranch[1],
    };
  }
  const onWordBranch = text.match(/\bon\s+([\w./-]+)\s+branch\b/i);
  if (onWordBranch) {
    return {
      prompt: text.replace(onWordBranch[0], "").trim(),
      baseBranch: onWordBranch[1],
    };
  }
  return { prompt: text };
}

// ─── Proposal store (avoid Slack value 2KB limit) ───────────────────────────

interface StoredProposal {
  repoId: string;
  workflow: string;
  inputs: Record<string, string>;
  alternatives: string[];
  prompt: string;
  confidence: number;
  reason: string;
  channel: string;
  threadTs: string;
  baseBranch?: string;
  /** Prior Slack thread discussion passed to `/api/harness/execute`. */
  threadContext?: string;
  /** When multiple Run buttons belong to one message, delete all on cancel/run. */
  relatedProposalIds?: string[];
}

const proposalStore = new Map<string, StoredProposal>();
let proposalCounter = 0;

function storeProposal(p: StoredProposal): string {
  const id = `p-${++proposalCounter}-${Date.now()}`;
  if (
    (p.workflow === "test" || p.workflow === "test-fix") &&
    p.baseBranch?.trim()
  ) {
    p.inputs = { ...p.inputs, branch: p.baseBranch.trim() };
  }
  proposalStore.set(id, p);
  setTimeout(() => proposalStore.delete(id), 10 * 60 * 1000);
  return id;
}

function deleteProposalGroup(proposalId: string): void {
  const p = proposalStore.get(proposalId);
  const ids = p?.relatedProposalIds?.length ? p.relatedProposalIds : [proposalId];
  for (const id of ids) proposalStore.delete(id);
}

// ─── Workflow catalog (Help) ────────────────────────────────────────────────

interface WorkflowCatalogEntry {
  name: string;
  description: string;
  inputs: { id: string; label: string; required?: boolean }[];
}

async function fetchReposDetailed(): Promise<
  { id: string; name: string; defaultBranch: string }[]
> {
  const res = await fetch(`${ZEVERSE_SERVER_URL}/api/repos`);
  const data = await zeverseResponseJson<{
    repos: { id: string; name: string; defaultBranch?: string }[];
  }>(res, "GET /api/repos");
  return (data.repos ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    defaultBranch: (r.defaultBranch ?? "").trim() || "main",
  }));
}

/** Slack mrkdwn: explicit chosen branch vs repo default (for test / test-fix proposals). */
function proposalBranchMrkdwn(
  p: StoredProposal,
  repoDefaultBranches: Record<string, string>
): string {
  const chosen = p.inputs.branch?.trim() || p.baseBranch?.trim();
  const db = repoDefaultBranches[p.repoId]?.trim();
  if (chosen) {
    return `*Chosen branch:* \`${chosen}\``;
  }
  if (db) {
    return `*Branch:* \`${db}\` _(repo default — override with \`branch=<name>\`)_`;
  }
  return `*Branch:* _repo default — add \`branch=<name>\` to your message to pin a branch_`;
}

/** Line for “workflow started” card: chosen branch or resolved repo default for test workflows. */
async function branchLineForWorkflowStart(p: StoredProposal): Promise<string | undefined> {
  const explicit = p.inputs.branch?.trim() || p.baseBranch?.trim();
  if (explicit) return `*Chosen branch:* \`${explicit}\``;
  if (p.workflow !== "test" && p.workflow !== "test-fix") return undefined;
  try {
    const repos = await fetchReposDetailed();
    const db = repos.find((r) => r.id === p.repoId)?.defaultBranch?.trim();
    if (db) return `*Branch:* \`${db}\` _(repo default)_`;
  } catch {
    /* best-effort */
  }
  return `*Branch:* _repo default_`;
}

async function fetchWorkflowsCatalog(repoId: string): Promise<WorkflowCatalogEntry[]> {
  const res = await fetch(
    `${ZEVERSE_SERVER_URL}/api/workflows?repoId=${encodeURIComponent(repoId)}`
  );
  const data = await zeverseResponseJson<{ workflows: WorkflowCatalogEntry[] }>(
    res,
    "GET /api/workflows"
  );
  return data.workflows ?? [];
}

function workflowListMrkdwn(repoId: string, workflows: WorkflowCatalogEntry[]): string {
  const lines: string[] = [`*Repo \`${repoId}\`*`];
  for (const w of workflows) {
    if (w.name === "harness") continue;
    const ins = (w.inputs ?? [])
      .map(
        (i) =>
          `\`${i.id}\`${i.required ? " _(required)_" : ""} — ${i.label}`
      )
      .join("\n   ");
    lines.push(`• *\`${w.name}\`* — ${w.description}`);
    if (ins) lines.push(`  _Inputs:_\n   ${ins}`);
  }
  if (lines.length === 1) lines.push("_No workflows (or only `harness`)._");
  return lines.join("\n");
}

/** Split long mrkdwn into section blocks (Slack ~3000 per section). */
function mrkdwnToSections(mrkdwn: string, maxChunk = 2800): { type: string; text: { type: string; text: string } }[] {
  const out: { type: string; text: { type: string; text: string } }[] = [];
  let rest = mrkdwn;
  while (rest.length > 0) {
    const chunk = rest.length <= maxChunk ? rest : rest.slice(0, maxChunk);
    out.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    rest = rest.slice(chunk.length);
  }
  return out;
}

async function buildWorkflowHelpBlocks(
  repoId: string | null
): Promise<{ type: string; text: { type: string; text: string } }[]> {
  if (repoId) {
    const wfs = await fetchWorkflowsCatalog(repoId);
    const md = workflowListMrkdwn(repoId, wfs);
    return mrkdwnToSections(md);
  }
  const repos = await fetchReposDetailed();
  const blocks: { type: string; text: { type: string; text: string } }[] = [];
  for (const r of repos) {
    const wfs = await fetchWorkflowsCatalog(r.id);
    blocks.push(...mrkdwnToSections(workflowListMrkdwn(r.id, wfs)));
  }
  return blocks.length > 0 ? blocks : mrkdwnToSections("_No repos registered._");
}

async function postWorkflowHelpEphemeral(
  client: any,
  channel: string,
  userId: string,
  thread_ts: string | undefined,
  repoId: string | null,
  logger: any
): Promise<void> {
  try {
    const blocks = await buildWorkflowHelpBlocks(repoId);
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts,
      text: "Zeverse workflow catalog",
      blocks: blocks.slice(0, 45),
    });
  } catch (err: any) {
    logger.error("postWorkflowHelpEphemeral:", err);
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts,
      text: `Could not load workflow catalog: ${err.message}`,
    });
  }
}

// ─── PRD PR proposal store (confirmation before raising PR) ─────────────────

interface PrdPrProposal {
  repoId: string;
  runId: string;
  channel: string;
  threadTs: string;
  docUrl: string;
}

const PRD_PR_PROPOSAL_TTL_MS = 10 * 60 * 1000;

interface PrdPrEntry {
  proposal: PrdPrProposal;
  timer: NodeJS.Timeout;
}

const prdPrStore = new Map<string, PrdPrEntry>();
let prdPrCounter = 0;

function armPrdPrTimer(id: string): NodeJS.Timeout {
  return setTimeout(() => prdPrStore.delete(id), PRD_PR_PROPOSAL_TTL_MS);
}

function storePrdPrProposal(p: PrdPrProposal): string {
  const id = `prd-pr-${++prdPrCounter}-${Date.now()}`;
  prdPrStore.set(id, { proposal: p, timer: armPrdPrTimer(id) });
  return id;
}

function getPrdPrProposal(id: string): PrdPrProposal | undefined {
  const entry = prdPrStore.get(id);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  entry.timer = armPrdPrTimer(id);
  return entry.proposal;
}

function deletePrdPrProposal(id: string): void {
  const entry = prdPrStore.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  prdPrStore.delete(id);
}

// ─── Block Kit confirm UI ───────────────────────────────────────────────────

function proposalBlocks(
  runProposalIds: string[],
  repoDefaultBranches: Record<string, string> = {}
): any[] {
  const resolved = runProposalIds
    .map((id) => ({ id, p: proposalStore.get(id) }))
    .filter((x): x is { id: string; p: StoredProposal } => !!x.p);
  if (resolved.length === 0) return [];

  const p0 = resolved[0].p;
  const helpBtn = {
    type: "button",
    text: { type: "plain_text", text: "Help" },
    action_id: "harness_help",
    value: p0.repoId,
  };

  if (p0.workflow === "prd-analysis") {
    const proposalId = resolved[0].id;
    const docUrl = p0.inputs.docUrl ?? "";
    const docLink = docUrl ? `<${docUrl}|Open PRD>` : "";
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `I can run *PRD analysis* on \`${p0.repoId}\`.`,
            docLink,
            `_Tap *Run* when you’re ready — I’ll summarize back in this thread._`,
          ].filter(Boolean).join("\n\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Run" },
            style: "primary",
            action_id: "harness_run",
            value: proposalId,
          },
          helpBtn,
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel" },
            action_id: "harness_cancel",
            value: proposalId,
          },
        ],
      },
    ];
  }

  const promptPreview =
    p0.prompt.length > 200 ? p0.prompt.slice(0, 200) + "…" : p0.prompt;
  const altLinesMaxInline = 5;
  const altLines =
    p0.alternatives.length > 0
      ? p0.alternatives.length <= altLinesMaxInline
        ? `\n\n*Other workflows you could pick:*\n${p0.alternatives
            .map((a, i) => `${i + 1}. \`${a}\``)
            .join("\n")}`
        : "\n\n_Use the menu below to choose a different workflow._"
      : "";

  const intro =
    resolved.length > 1
      ? `*Top workflow picks* for \`${p0.repoId}\`:`
      : `I’m suggesting a workflow for \`${p0.repoId}\`:`;
  const pickLines: string[] = [intro, ""];
  for (let i = 0; i < resolved.length; i++) {
    const p = resolved[i].p;
    pickLines.push(
      `${i + 1}. *\`${p.workflow}\`* — ${(p.confidence * 100).toFixed(0)}% — _${p.reason}_`
    );
  }
  pickLines.push(
    "",
    `*Your ask:* ${promptPreview}`,
    altLines,
    "\n_Use a *Run* button to start that workflow, *Help* for the full catalog, or *Pick another…*_"
  );

  const branchWorkflowIdx = resolved.findIndex(
    (x) => x.p.workflow === "test" || x.p.workflow === "test-fix"
  );
  if (branchWorkflowIdx >= 0) {
    pickLines.push(
      "",
      proposalBranchMrkdwn(resolved[branchWorkflowIdx].p, repoDefaultBranches)
    );
  }

  const runButtons = resolved.slice(0, 3).map(({ id, p }, i) => {
    const wfShort =
      p.workflow.length > 36 ? `${p.workflow.slice(0, 33)}…` : p.workflow;
    const label = resolved.length === 1 ? "Run" : `Run ${wfShort}`;
    const el: Record<string, unknown> = {
      type: "button",
      text: { type: "plain_text", text: label.slice(0, 75) },
      action_id: "harness_run",
      value: id,
    };
    if (i === 0) (el as { style?: string }).style = "primary";
    return el;
  });

  const row2: any[] = [helpBtn];
  if (p0.alternatives.length > 0) {
    row2.push({
      type: "static_select",
      placeholder: { type: "plain_text", text: "Pick another…" },
      action_id: "harness_pick",
      options: p0.alternatives.map((alt) => ({
        text: {
          type: "plain_text",
          text: alt.length > 75 ? `${alt.slice(0, 72)}…` : alt,
        },
        value: `${resolved[0].id}:${alt}`,
      })),
    });
  }
  row2.push({
    type: "button",
    text: { type: "plain_text", text: "Cancel" },
    action_id: "harness_cancel",
    value: resolved[0].id,
  });

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: pickLines.join("\n"),
      },
    },
    { type: "actions", elements: runButtons },
    { type: "actions", elements: row2 },
  ];
}

// ─── Pending thread-reply asks (debug workflow) ─────────────────────────────

interface PendingThreadAsk {
  runId: string;
  repoId: string;
  channel: string;
  threadTs: string;
  expectFiles: string[];
}

const pendingThreadAsks = new Map<string, PendingThreadAsk>();

function registerPendingThreadAsk(ask: PendingThreadAsk): void {
  pendingThreadAsks.set(`${ask.channel}:${ask.threadTs}`, ask);
}

function lookupPendingThreadAsk(channel: string, threadTs: string): PendingThreadAsk | undefined {
  return pendingThreadAsks.get(`${channel}:${threadTs}`);
}

function removePendingThreadAsk(channel: string, threadTs: string): void {
  pendingThreadAsks.delete(`${channel}:${threadTs}`);
}

function classifyFileByExtension(filename: string): "har" | "screenshot" | "attachment" {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".har") return "har";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "screenshot";
  return "attachment";
}

async function downloadSlackFile(
  urlPrivateDownload: string,
  destPath: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
  const res = await fetch(urlPrivateDownload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Slack file download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

async function downloadAndForwardThreadReply(
  ask: PendingThreadAsk,
  message: any,
  client: any,
  logger: any
): Promise<void> {
  const text = (message.text ?? "").trim();
  const slackFiles = message.files ?? [];

  const uploadsDir = path.join(
    HUB_STATE_DIR, ask.repoId, "runs", ask.runId, "uploads"
  );

  const downloadedFiles: { kind: string; path: string }[] = [];

  for (const f of slackFiles) {
    const downloadUrl = f.url_private_download ?? f.url_private;
    if (!downloadUrl) continue;

    const originalName = f.name ?? `file_${Date.now()}`;
    const destPath = path.join(uploadsDir, originalName);

    try {
      await downloadSlackFile(downloadUrl, destPath);
      const kind = classifyFileByExtension(originalName);
      downloadedFiles.push({ kind, path: destPath });
      logger.info(`Downloaded ${kind} file: ${destPath}`);
    } catch (err: any) {
      logger.error(`Failed to download Slack file ${originalName}: ${err.message}`);
    }
  }

  try {
    const res = await fetch(
      `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(ask.runId)}/thread-reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          by: message.user ?? "unknown",
          text,
          files: downloadedFiles,
        }),
      }
    );
    const data = await zeverseResponseJson<{ resumed?: boolean; error?: string }>(
      res, "POST /api/runs/:id/thread-reply"
    );

    if (data.error) {
      await client.chat.postMessage({
        channel: ask.channel,
        thread_ts: ask.threadTs,
        text: `Failed to resume debug run: ${data.error}`,
      });
      return;
    }

    const filesSummary = downloadedFiles.length > 0
      ? ` (${downloadedFiles.length} file(s): ${downloadedFiles.map((f) => f.kind).join(", ")})`
      : "";
    await client.chat.postMessage({
      channel: ask.channel,
      thread_ts: ask.threadTs,
      text: `_Got it${filesSummary} — resuming the debug run..._`,
    });
  } catch (err: any) {
    logger.error(`Failed to forward thread reply to Zeverse: ${err.message}`);
    await client.chat.postMessage({
      channel: ask.channel,
      thread_ts: ask.threadTs,
      text: `Error forwarding your reply to Zeverse: ${err.message}`,
    });
  }
}

// ─── Run event poller (milestones + approval detection) ─────────────────────

const MILESTONE_STEPS = new Set(
  (process.env.ZEVERSE_MILESTONE_STEPS ?? "plan,implement,validate,review,open-pr")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

interface RunEventLine {
  ts: string;
  type: string;
  stepId?: string;
  stepKind?: string;
  status?: string;
  error?: string;
  prompt?: string;
  surface?: string;
  [key: string]: any;
}

async function pollRunEvents(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 400;
  const intervalMs = 3000;
  let offset = 0;
  const postedMilestones = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let content: string;
    let nextOffset: number;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/events?repoId=${encodeURIComponent(repoId)}&offset=${offset}`
      );
      const data = await zeverseResponseJson<{ content: string; nextOffset: number }>(
        res, "GET /api/runs/:id/events"
      );
      content = data.content;
      nextOffset = data.nextOffset;
    } catch {
      continue;
    }

    if (content) {
      offset = nextOffset;
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        let ev: RunEventLine;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === "awaiting_approval" && ev.stepId) {
          const approvalMsgRaw = ev.prompt ?? "Approval required to continue this workflow.";
          const approvalMsg = sanitizeForSlackMrkdwn(approvalMsgRaw);
          await client.chat.postMessage({
            channel,
            thread_ts,
            text: `*Approval needed* — \`${ev.stepId}\`\n${approvalMsg}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Approval needed* for step \`${ev.stepId}\`\n${approvalMsg}`,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Approve" },
                    style: "primary",
                    action_id: "approval_approve",
                    value: `${runId}:${repoId}`,
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Reject" },
                    style: "danger",
                    action_id: "approval_reject",
                    value: `${runId}:${repoId}`,
                  },
                ],
              },
            ],
          });
        }

        if (ev.type === "awaiting_thread_reply" && ev.stepId) {
          const askMsg = sanitizeForSlackMrkdwn(
            ev.prompt ?? "Please reply in this thread with the requested information."
          );
          await client.chat.postMessage({
            channel,
            thread_ts,
            text: askMsg,
          });
          registerPendingThreadAsk({
            runId,
            repoId,
            channel,
            threadTs: thread_ts,
            expectFiles: Array.isArray(ev.expectFiles) ? ev.expectFiles : [],
          });
        }

        if (ev.type === "step_finished" && ev.stepId && MILESTONE_STEPS.has(ev.stepId)) {
          const key = `${ev.stepId}:${ev.status}`;
          if (!postedMilestones.has(key)) {
            postedMilestones.add(key);
            const icon = ev.status === "success" ? ":white_check_mark:" : ":x:";
            await client.chat.postMessage({
              channel,
              thread_ts,
              text: `${icon} Step \`${ev.stepId}\` ${ev.status}`,
            });
          }
        }

        if (ev.type === "run_finished" || ev.type === "gates_failed") {
          return;
        }
      }
    }

    // Also check if the run itself has terminated
    try {
      const runRes = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      const runState = await zeverseResponseJson<RunState>(runRes, "GET /api/runs/:id");
      if (runState.status === "success" || runState.status === "failed") return;
    } catch { /* continue */ }
  }
}

// ─── Unified harness message handler ────────────────────────────────────────

async function handleHarnessMessage(
  rawPrompt: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any,
  surface: "slash" | "mention" | "dm",
  repoIdHint?: string | null
): Promise<void> {
  const { prompt, baseBranch } = extractBranchFlag(rawPrompt);
  const messages = await fetchThreadMessages(channel, thread_ts, client);
  const threadContext = buildGenericThreadContext(messages);

  let route: HarnessRouteResult;
  try {
    route = await callHarnessRoute(prompt, threadContext, repoIdHint ?? null, surface);
  } catch (err: any) {
    logger.error(`harness/route call failed: ${err.message}`);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
    return;
  }

  if (route.type === "answer") {
    let raw = route.answer ?? "I don't have an answer for that right now.";
    if (route.error && !raw.includes(route.error)) {
      raw = `${raw}\n\n_${route.error}_`;
    }
    const text = formatHarnessAnswerForSlack(raw);
    await client.chat.postMessage({ channel, thread_ts, text });
    return;
  }

  if (route.type === "clarify") {
    const raw =
      (route.clarifyingQuestion ?? route.question)?.trim() ||
      "Could you provide more details?";
    const bodyOnly = formatLLMTextForSlack(raw);
    await client.chat.postMessage({ channel, thread_ts, text: bodyOnly });
    return;
  }

  let repoDefaultBranches: Record<string, string> = {};
  if (route.type === "answer_with_proposal" || route.type === "proposal") {
    try {
      const repos = await fetchReposDetailed();
      repoDefaultBranches = Object.fromEntries(
        repos.map((r) => [r.id, r.defaultBranch])
      );
    } catch {
      repoDefaultBranches = {};
    }
  }

  if (route.type === "answer_with_proposal") {
    let raw = route.answer ?? "";
    if (route.error && raw && !raw.includes(route.error)) {
      raw = `${raw}\n\n_${route.error}_`;
    }
    const repoIdProposal = route.repoId;
    if (!repoIdProposal) {
      const fallback = raw.trim()
        ? formatLLMTextForSlack(raw)
        : await noRepoErrorText("@ZeverseBot");
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: fallback,
      });
      return;
    }
    const summaryText =
      raw.trim().length > 0
        ? formatHarnessAnswerForSlack(raw)
        : `_${sanitizeForSlackMrkdwn(route.reason || "Suggested workflow — tap *Run* when you’re ready.")}_`;

    const suggestionsAp =
      route.suggestions && route.suggestions.length > 0
        ? route.suggestions
        : [
            {
              workflow: route.workflow ?? DEFAULT_WORKFLOW,
              inputs: route.inputs ?? { requirement: prompt },
              confidence: route.confidence,
              reason: route.reason,
            },
          ];
    const alternativesAp = route.alternatives ?? [];
    const idsAp = suggestionsAp.map((s) =>
      storeProposal({
        repoId: repoIdProposal,
        workflow: s.workflow,
        inputs: s.inputs,
        alternatives: alternativesAp,
        prompt,
        confidence: s.confidence,
        reason: s.reason,
        channel,
        threadTs: thread_ts,
        baseBranch,
        threadContext: threadContext.trim() ? threadContext : undefined,
      })
    );
    for (const id of idsAp) {
      const pr = proposalStore.get(id)!;
      pr.relatedProposalIds = [...idsAp];
    }
    const primaryAp = suggestionsAp[0];
    await client.chat.postMessage({
      channel,
      thread_ts,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: summaryText },
        },
        ...proposalBlocks(idsAp, repoDefaultBranches),
      ],
      text:
        summaryText +
        `\n\nOptional workflow: *${primaryAp.workflow}* on \`${repoIdProposal}\`.`,
    });
    return;
  }

  const repoId = route.repoId;

  if (!repoId) {
    const q = route.question
      ? sanitizeForSlackMrkdwn(route.question)
      : "Which repository should I work with? " + (await noRepoErrorText("@ZeverseBot"));
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: q,
    });
    return;
  }

  const suggestions =
    route.suggestions && route.suggestions.length > 0
      ? route.suggestions
      : [
          {
            workflow: route.workflow ?? DEFAULT_WORKFLOW,
            inputs: route.inputs ?? { requirement: prompt },
            confidence: route.confidence,
            reason: route.reason,
          },
        ];

  const alternatives = route.alternatives ?? [];

  const ids = suggestions.map((s) =>
    storeProposal({
      repoId,
      workflow: s.workflow,
      inputs: s.inputs,
      alternatives,
      prompt,
      confidence: s.confidence,
      reason: s.reason,
      channel,
      threadTs: thread_ts,
      baseBranch,
      threadContext: threadContext.trim() ? threadContext : undefined,
    })
  );
  for (const id of ids) {
    const pr = proposalStore.get(id)!;
    pr.relatedProposalIds = [...ids];
  }

  const primary = suggestions[0];
  await client.chat.postMessage({
    channel,
    thread_ts,
    blocks: proposalBlocks(ids, repoDefaultBranches),
    text:
      suggestions.length > 1
        ? `I’m proposing ${suggestions.length} workflows on \`${repoId}\`. Tap *Run* on the best match.`
        : `I’m proposing *\`${primary.workflow}\`* on *\`${repoId}\`*. Tap *Run* in the thread to start.`,
  });
}

// ─── Button action: Run ─────────────────────────────────────────────────────
app.action("harness_run", async ({ action, ack, body, client, logger }) => {
  await ack();
  const proposalId = (action as any).value;
  const p = proposalStore.get(proposalId);
  if (!p) {
    await client.chat.postMessage({
      channel: (body as any).channel?.id,
      text: "This proposal has expired. Please re-send your request.",
    });
    return;
  }

  const messageTs = (body as any).message?.ts;
  const channel = (body as any).channel?.id;
  const thread_ts = p.threadTs;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Running \`${p.workflow}\` on \`${p.repoId}\`...`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Running \`${p.workflow}\` on \`${p.repoId}\`..._`,
          },
        },
      ],
    }).catch(() => {});
  }

  const slackUser = (body as any).user?.id;
  try {
    const result = await callHarnessExecute(p.repoId, p.workflow, p.inputs, p.prompt, {
      slackUser,
      channel,
      surface: "slack",
      baseBranch: p.baseBranch,
      threadContext: p.threadContext,
    });
    if (result.error) {
      const missingMsg = result.missing?.length
        ? `\n_Missing inputs: ${result.missing.map((m: string) => `\`${m}\``).join(", ")}_`
        : "";
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Failed to start workflow: ${result.error}${missingMsg}`,
      });
      return;
    }
    const runId = result.runId ?? "";

    if (p.workflow === "prd-analysis") {
      const docUrl = p.inputs.docUrl ?? "";
      await client.chat.postMessage({
        channel,
        thread_ts,
        text:
          `*PRD analysis started* on \`${p.repoId}\` for <${docUrl}|Open PRD>\n` +
          `Run: \`${runId}\` | <${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>\n` +
          `_I'll reply in this thread when the analysis is done._`,
      });
      pollRunAndReply(runId, p.repoId, channel, thread_ts, docUrl, client, logger).catch(
        (err) => logger.error("pollRunAndReply (harness_run prd) error:", err)
      );
    } else {
      const branchLine = await branchLineForWorkflowStart(p);
      await client.chat.postMessage({
        channel,
        thread_ts,
        blocks: successBlocks(
          { repoId: p.repoId, workflow: p.workflow, prompt: p.prompt, runId },
          { branchLine }
        ),
        text: `Zeverse run ${runId} started for ${p.repoId}/${p.workflow}`,
      });
      pollRunAndPostResult(runId, p.repoId, channel, thread_ts, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult (harness_run) error:", err)
      );
    }

    saveHarnessThread({
      channel,
      threadTs: thread_ts,
      repoId: p.repoId,
      lastRunId: runId,
      lastWorkflow: p.workflow,
      history: [p.prompt],
    });
    pollRunEvents(runId, p.repoId, channel, thread_ts, client, logger).catch(
      (err) => logger.error("pollRunEvents (harness_run) error:", err)
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
  }
  deleteProposalGroup(proposalId);
});

// ─── Button action: Pick another ────────────────────────────────────────────
app.action("harness_pick", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).selected_option?.value ?? "";
  const sepIdx = raw.indexOf(":");
  if (sepIdx === -1) return;
  const proposalId = raw.slice(0, sepIdx);
  const newWorkflow = raw.slice(sepIdx + 1);

  const p = proposalStore.get(proposalId);
  if (!p) {
    await client.chat.postMessage({
      channel: (body as any).channel?.id,
      text: "This proposal has expired. Please re-send your request.",
    });
    return;
  }

  p.workflow = newWorkflow;
  p.alternatives = p.alternatives.filter((a) => a !== newWorkflow);
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Running \`${newWorkflow}\` on \`${p.repoId}\`...`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Running \`${newWorkflow}\` on \`${p.repoId}\`..._`,
          },
        },
      ],
    }).catch(() => {});
  }

  const slackUser = (body as any).user?.id;
  try {
    const result = await callHarnessExecute(p.repoId, newWorkflow, p.inputs, p.prompt, {
      slackUser,
      channel,
      surface: "slack",
      baseBranch: p.baseBranch,
      threadContext: p.threadContext,
    });
    if (result.error) {
      const missingMsg = result.missing?.length
        ? `\n_Missing inputs: ${result.missing.map((m: string) => `\`${m}\``).join(", ")}_`
        : "";
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        text: `Failed to start workflow: ${result.error}${missingMsg}`,
      });
      return;
    }
    const runId = result.runId ?? "";

    if (newWorkflow === "prd-analysis") {
      const docUrl = p.inputs.docUrl ?? "";
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        text:
          `*PRD analysis started* on \`${p.repoId}\` for <${docUrl}|Open PRD>\n` +
          `Run: \`${runId}\` | <${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>\n` +
          `_I'll reply in this thread when the analysis is done._`,
      });
      pollRunAndReply(runId, p.repoId, channel, p.threadTs, docUrl, client, logger).catch(
        (err) => logger.error("pollRunAndReply (harness_pick prd) error:", err)
      );
    } else {
      const branchLine = await branchLineForWorkflowStart(p);
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        blocks: successBlocks(
          { repoId: p.repoId, workflow: newWorkflow, prompt: p.prompt, runId },
          { branchLine }
        ),
        text: `Zeverse run ${runId} started for ${p.repoId}/${newWorkflow}`,
      });
      pollRunAndPostResult(runId, p.repoId, channel, p.threadTs, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult (harness_pick) error:", err)
      );
    }

    saveHarnessThread({
      channel,
      threadTs: p.threadTs,
      repoId: p.repoId,
      lastRunId: runId,
      lastWorkflow: newWorkflow,
      history: [p.prompt],
    });
    pollRunEvents(runId, p.repoId, channel, p.threadTs, client, logger).catch(
      (err) => logger.error("pollRunEvents (harness_pick) error:", err)
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: p.threadTs,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
  }
  deleteProposalGroup(proposalId);
});

// ─── Test workflow: start test-fix from thread ───────────────────────────────
app.action("test_run_fix_failing", async ({ ack, body, client, logger }) => {
  await ack();
  const rawVal = String((body as any).actions?.[0]?.value ?? "").trim();
  const sep = rawVal.indexOf(":");
  const channel = (body as any).channel?.id;
  const thread_ts =
    (body as any).message?.thread_ts ?? (body as any).message?.ts;
  const slackUser = (body as any).user?.id;
  if (sep === -1 || !channel || !thread_ts || !slackUser) return;

  const repoId = rawVal.slice(0, sep).trim();
  const priorRunId = rawVal.slice(sep + 1).trim();
  if (!repoId || !priorRunId) return;

  const messages = await fetchThreadMessages(channel, thread_ts, client);
  const threadBits = [
    `Follow-up from test workflow run \`${priorRunId}\`: fix failing tests.`,
    buildGenericThreadContext(messages),
  ].filter(Boolean);
  const threadContext = threadBits.join("\n\n");

  const prompt = `Fix failing tests (after test run ${priorRunId})`;

  try {
    const result = await callHarnessExecute(repoId, "test-fix", {}, prompt, {
      slackUser,
      channel,
      surface: "slack",
      threadContext: threadContext || undefined,
    });
    const errMsg = result.error?.trim();
    if (errMsg || !result.runId) {
      const notFound = !result.runId || /not found|404/i.test(errMsg ?? "");
      const friendly = notFound
        ? `Could not start *test-fix* for \`${repoId}\`. Add a \`test-fix\` workflow under \`.zeverse/workflows/\` in that repo (copy from the Zeverse hub if needed), then refresh workflows.${errMsg ? `\n_${errMsg}_` : ""}`
        : `Failed to start test-fix: ${errMsg}`;
      await client.chat.postMessage({ channel, thread_ts, text: friendly });
      return;
    }

    const runId = result.runId;
    const branchLine = await branchLineForWorkflowStart({
      repoId,
      workflow: "test-fix",
      inputs: {},
      alternatives: [],
      prompt,
      confidence: 1,
      reason: "test-fix follow-up",
      channel: channel ?? "",
      threadTs: thread_ts ?? "",
    } as StoredProposal);
    await client.chat.postMessage({
      channel,
      thread_ts,
      blocks: successBlocks(
        { repoId, workflow: "test-fix", prompt, runId },
        { branchLine }
      ),
      text: `Zeverse test-fix run ${runId} started for ${repoId}`,
    });
    pollRunAndPostResult(runId, repoId, channel, thread_ts, client, logger).catch((err) =>
      logger.error("pollRunAndPostResult (test_run_fix_failing) error:", err)
    );
    pollRunEvents(runId, repoId, channel, thread_ts, client, logger).catch((err) =>
      logger.error("pollRunEvents (test_run_fix_failing) error:", err)
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error starting test-fix: ${err.message}`,
    });
  }
});

// ─── Button action: Help (workflow catalog) ─────────────────────────────────
app.action("harness_help", async ({ ack, action, body, client, logger }) => {
  await ack();
  const repoId = String((action as any).value ?? "").trim();
  const userId = (body as any).user?.id;
  const channel = (body as any).channel?.id;
  const thread_ts = (body as any).message?.thread_ts ?? (body as any).message?.ts;
  if (!userId || !channel) return;
  await postWorkflowHelpEphemeral(client, channel, userId, thread_ts, repoId || null, logger);
});

// ─── Button action: Cancel ──────────────────────────────────────────────────
app.action("harness_cancel", async ({ action, ack, body, client }) => {
  await ack();
  const proposalId = (action as any).value;
  deleteProposalGroup(proposalId);
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: "Cancelled.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "_Cancelled._" },
        },
      ],
    }).catch(() => {});
  }
});

// ─── Button action: Raise PRD PR (confirmed) ───────────────────────────────
app.action("prd_confirm_pr", async ({ action, ack, body, client, logger }) => {
  await ack();
  const prdPrId = (action as any).value;
  const proposal = getPrdPrProposal(prdPrId);
  if (!proposal) {
    await client.chat.postMessage({
      channel: (body as any).channel?.id,
      text: "This PRD PR proposal has expired. Re-run `/zeverse-prd` to generate a new one.",
    });
    return;
  }

  const messageTs = (body as any).message?.ts;
  const channel = (body as any).channel?.id;
  const { repoId, runId: analysisRunId, threadTs, docUrl } = proposal;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: "_Raising PR..._",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "_Raising PR... You can still click *Create FR Card* in parallel._" },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Create FR Card" },
              action_id: "prd_create_fr_card",
              value: prdPrId,
            },
          ],
        },
      ],
    }).catch(() => {});
  }

  let deliverableContent: string;
  try {
    const runRes = await fetch(
      `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(analysisRunId)}?repoId=${encodeURIComponent(repoId)}`
    );
    const state = await zeverseResponseJson<RunState>(runRes, "GET /api/runs/:id");
    const deliverableStep = state.steps.find((s) => s.id === "deliverable");
    if (!deliverableStep?.output) {
      if (messageTs && channel) {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: "Cannot raise a PR — the workflow's deliverable step produced no plan output.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "_Cannot raise a PR — the workflow's deliverable step produced no plan output. Re-run `/zeverse-prd` with a more detailed PRD or check the workflow logs._",
              },
            },
          ],
        }).catch(() => {});
      }
      const userId = (body as any).user?.id;
      if (userId && channel) {
        await client.chat.postEphemeral({
          channel,
          user: userId,
          text: "Cannot raise a PR — the workflow's deliverable step produced no plan output. Re-run `/zeverse-prd` to generate a fresh analysis.",
        }).catch(() => {});
      }
      return;
    }
    deliverableContent = deliverableStep.output;
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Error fetching analysis run: ${err.message}`,
    });
    return;
  }

  let result: RunResponse;
  try {
    result = await triggerWorkflow(repoId, "prd-raise-pr", `Raise PR for ${docUrl}`, {
      deliverableContent,
    });
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
    return;
  }

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Failed to start PRD raise-PR workflow: ${result.error}`,
    });
    return;
  }

  const raiseRunId = result.runId ?? "";

  pollPrdRaiseAndReply(raiseRunId, repoId, channel, threadTs, docUrl, client, logger).catch(
    (err) => logger.error("pollPrdRaiseAndReply error:", err)
  );
});

async function pollPrdRaiseAndReply(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  docUrl: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await zeverseResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("Raise PRD PR failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const openPrStep = state.steps.find((s) => s.id === "open-pr");
    const output = openPrStep?.output ?? "";
    const branchMatch = output.match(/BRANCH=(\S+)/);
    const prUrlMatch = output.match(/PR_URL=(https?:\/\/\S+)/);

    const parts: string[] = [`*PRD PR raised* — here’s the link for \`${repoId}\`.`, ""];
    let raised = 0;
    if (branchMatch) parts.push(`${++raised}. Branch: \`${branchMatch[1]}\``);
    if (prUrlMatch) parts.push(`${++raised}. PR: <${prUrlMatch[1]}|View on GitHub>`);
    parts.push("");
    parts.push(
      `<${docUrl}|Open PRD in Google Docs>  |  <${ZEVERSE_UI_URL}/?run=${runId}|View raise-PR run in Zeverse>`
    );

    await client.chat.postMessage({ channel, thread_ts, text: parts.join("\n") });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD raise-PR timed out* — the run is still going.\n` +
      `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
  });
}

// ─── Button action: Cancel PRD PR ───────────────────────────────────────────
app.action("prd_cancel_pr", async ({ action, ack, body, client }) => {
  await ack();
  const prdPrId = (action as any).value;
  deletePrdPrProposal(prdPrId);
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: "Cancelled — re-run `/zeverse-prd` if you change your mind.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_Cancelled — re-run `/zeverse-prd` if you change your mind._",
          },
        },
      ],
    }).catch(() => {});
  }
});

// ─── Button action: Create FR Card (opens confirmation modal) ───────────────

function extractDeliverablePreview(content: string): string {
  const lines = content.split("\n");
  const preview: string[] = [];
  for (const line of lines) {
    if (/^epic:/i.test(line.trim()) || /^#+\s/.test(line.trim()) || /^[-*]\s/.test(line.trim())) {
      preview.push(line);
    }
    if (preview.length >= 30) break;
  }
  if (preview.length === 0) {
    return content.length > 2800 ? content.slice(0, 2800) + "\n…" : content;
  }
  const text = preview.join("\n");
  return text.length > 2800 ? text.slice(0, 2800) + "\n…" : text;
}

app.action("prd_create_fr_card", async ({ action, ack, body, client, logger }) => {
  await ack();
  const prdPrId = (action as any).value;
  const channel = (body as any).channel?.id;
  const triggerId = (body as any).trigger_id;
  const messageThreadTs = (body as any).message?.thread_ts ?? (body as any).message?.ts;

  let proposal = getPrdPrProposal(prdPrId);
  if (!proposal && channel) {
    const ctx =
      (messageThreadTs && lookupPrdThread(channel, messageThreadTs)) ||
      lookupPrdThreadByChannel(channel) ||
      (messageThreadTs && discoverPrdContextFromState(channel, messageThreadTs, logger)) ||
      undefined;
    if (ctx) {
      proposal = {
        repoId: ctx.repoId,
        runId: ctx.runId,
        channel: ctx.channel,
        threadTs: ctx.threadTs,
        docUrl: ctx.docUrl,
      };
      prdPrStore.set(prdPrId, { proposal, timer: armPrdPrTimer(prdPrId) });
      logger.info(`prd_create_fr_card: recovered proposal from PrdThreadContext (run=${ctx.runId})`);
    }
  }
  if (!proposal) {
    await client.chat.postMessage({
      channel: channel,
      text: "This proposal has expired and could not be recovered. Re-run `/zeverse-prd` to generate a new one.",
    });
    return;
  }

  const { repoId, runId: analysisRunId, threadTs, docUrl } = proposal;

  let deliverableContent: string;
  try {
    const runRes = await fetch(
      `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(analysisRunId)}?repoId=${encodeURIComponent(repoId)}`
    );
    const state = await zeverseResponseJson<RunState>(runRes, "GET /api/runs/:id");
    const deliverableStep = state.steps.find((s) => s.id === "deliverable");
    if (!deliverableStep?.output) {
      if (channel) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "_Cannot create FR cards — the deliverable step produced no output. Re-run `/zeverse-prd` with a more detailed PRD._",
        });
      }
      return;
    }
    deliverableContent = deliverableStep.output;
  } catch (err: any) {
    if (channel) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Error fetching analysis run: ${err.message}`,
      });
    }
    return;
  }

  const previewRaw = extractDeliverablePreview(deliverableContent);
  const preview = sanitizeForSlackMrkdwn(previewRaw);

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "prd_create_fr_card_submit",
        title: { type: "plain_text", text: "Create FR Cards" },
        submit: { type: "plain_text", text: "Create" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ prdPrId, repoId, runId: analysisRunId, channel, threadTs, docUrl }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Epic & Tasks preview:*\n${preview}`,
            },
          },
          {
            type: "divider",
          },
          {
            type: "input",
            block_id: "workspace",
            element: {
              type: "plain_text_input",
              action_id: "workspace_input",
              initial_value: "BILLING",
              placeholder: { type: "plain_text", text: "Freshrelease workspace key" },
            },
            label: { type: "plain_text", text: "Workspace" },
          },
        ],
      },
    });
  } catch (err: any) {
    logger.error("prd_create_fr_card views.open failed:", err);
    if (channel) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Failed to open confirmation modal: ${err.message}`,
      });
    }
  }
});

// ─── View submission: Create FR Card confirmed ──────────────────────────────

app.view("prd_create_fr_card_submit", async ({ ack, view, client, logger }) => {
  await ack();

  let meta: any;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    logger.error("prd_create_fr_card_submit: invalid private_metadata");
    return;
  }

  const prdPrId: string = meta.prdPrId;
  let proposal = getPrdPrProposal(prdPrId);
  if (!proposal && meta.repoId && meta.runId && meta.channel) {
    proposal = {
      repoId: meta.repoId,
      runId: meta.runId,
      channel: meta.channel,
      threadTs: meta.threadTs,
      docUrl: meta.docUrl,
    };
    logger.info(`prd_create_fr_card_submit: recovered proposal from private_metadata (run=${meta.runId})`);
  }
  if (!proposal) {
    logger.warn("prd_create_fr_card_submit: proposal expired and could not be recovered");
    return;
  }

  const { repoId, runId: analysisRunId, channel, threadTs, docUrl } = proposal;
  const workspace =
    view.state?.values?.workspace?.workspace_input?.value?.trim() || "BILLING";

  let deliverableContent: string;
  try {
    const runRes = await fetch(
      `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(analysisRunId)}?repoId=${encodeURIComponent(repoId)}`
    );
    const state = await zeverseResponseJson<RunState>(runRes, "GET /api/runs/:id");
    const deliverableStep = state.steps.find((s) => s.id === "deliverable");
    deliverableContent = deliverableStep?.output ?? "";
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Error fetching deliverable for FR card creation: ${err.message}`,
    });
    return;
  }

  if (!deliverableContent) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "_Cannot create FR cards — the deliverable is empty._",
    });
    return;
  }

  let result: RunResponse;
  try {
    result = await triggerWorkflow(
      repoId,
      "fr-card-creator",
      `Create FR cards from PRD ${docUrl}`,
      { requirement: deliverableContent, mode: "from-prd-md", workspace }
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Error connecting to Zeverse server: ${err.message}`,
    });
    return;
  }

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Failed to start FR card creation: ${result.error}`,
    });
    return;
  }

  const frRunId = result.runId ?? "";
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text:
      `_Creating FR cards in \`${workspace}\`..._\n` +
      `Run: \`${frRunId}\` | <${ZEVERSE_UI_URL}/?run=${frRunId}|View in Zeverse>`,
  });

  pollFrCardAndReply(frRunId, repoId, channel, threadTs, docUrl, workspace, client, logger).catch(
    (err) => logger.error("pollFrCardAndReply error:", err)
  );
});

interface FRCreateEntry {
  kind: string;
  title: string;
  key: string;
  url: string;
}

interface FRCreateFailure {
  kind: string;
  title: string;
  reason: string;
}

function parseFrCreateOutput(output: string): { successes: FRCreateEntry[]; failures: FRCreateFailure[]; total: number } {
  const successes: FRCreateEntry[] = [];
  const failures: FRCreateFailure[] = [];
  const successRe = /^\+ (Epic|Task|Bug|Story) "(.+?)" → ([A-Z]+-\d+) \((https?:\/\/\S+)\)$/;
  const failRe = /^FAIL (Epic|Task|Bug|Story) "(.+?)": (.+)$/;
  const headerRe = /^Created (\d+)\/(\d+) issues/;
  let total = 0;

  for (const line of output.split("\n")) {
    const sm = line.match(successRe);
    if (sm) { successes.push({ kind: sm[1], title: sm[2], key: sm[3], url: sm[4] }); continue; }
    const fm = line.match(failRe);
    if (fm) { failures.push({ kind: fm[1], title: fm[2], reason: fm[3] }); continue; }
    const hm = line.match(headerRe);
    if (hm) { total = Number(hm[2]); }
  }
  if (total === 0) total = successes.length + failures.length;
  return { successes, failures, total };
}

async function pollFrCardAndReply(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  docUrl: string,
  workspace: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await zeverseResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("FR card creation failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const createStep = state.steps.find((s) => s.id === "create");
    const createOutput = createStep?.output ?? "";
    const { successes, failures, total } = parseFrCreateOutput(createOutput);

    const parts: string[] = [];

    if (successes.length > 0 || failures.length > 0) {
      parts.push(`*Freshrelease cards created* — \`${repoId}\` — ${successes.length}/${total} in \`${workspace}\``);
      parts.push("");
      successes.forEach((s, i) => {
        parts.push(`${i + 1}. <${s.url}|${s.key}> — ${s.kind}: ${s.title}`);
      });
      if (failures.length > 0) {
        parts.push("");
        parts.push("*Failed:*");
        failures.forEach((f, i) => {
          parts.push(`${i + 1}. ${f.kind} "${f.title}": ${sanitizeForSlackMrkdwn(f.reason)}`);
        });
      }
    } else {
      const summaryStep = state.steps.find((s) => s.id === "summary");
      const output = summaryStep?.output || createOutput || "Cards created (no summary available).";
      parts.push(`*Freshrelease cards created* — \`${repoId}\``);
      parts.push("");
      parts.push(trimOutput(formatLLMTextForSlack(output)));
    }

    parts.push("");
    parts.push(`<${docUrl}|Open PRD in Google Docs>  |  <${ZEVERSE_UI_URL}/?run=${runId}|View run in Zeverse>`);

    await client.chat.postMessage({ channel, thread_ts, text: parts.join("\n") });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*FR card creation timed out* — the run is still going.\n` +
      `<${ZEVERSE_UI_URL}/?run=${runId}|View in Zeverse>`,
  });
}

// ─── Action: Assign owner to a PRD open question ───────────────────────────
app.action("prd_assign_owner", async ({ action, ack, body, client, logger }) => {
  await ack();

  const selectedUser = (action as any).selected_user as string | undefined;
  if (!selectedUser) return;

  const message = (body as any).message;
  const metadata = message?.metadata?.event_payload as
    | { runId: string; repoId: string; channel: string; threadTs: string; queryIndex: number; docId?: string }
    | undefined;
  if (!metadata) {
    logger.warn("prd_assign_owner: no metadata on message");
    return;
  }

  const { repoId, channel: ctxChannel, threadTs, queryIndex, docId } = metadata;
  const channel = (body as any).channel?.id ?? ctxChannel;
  const messageTs = message?.ts;

  const threadCtx = lookupPrdThread(ctxChannel, threadTs);
  if (threadCtx) {
    const q = threadCtx.queries.find((q) => q.index === queryIndex);
    if (q) {
      q.assignedUserId = selectedUser;
      savePrdThread(threadCtx);
    }
  }

  if (messageTs && channel) {
    const originalSection = message?.blocks?.[0];
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `[Q${queryIndex}] Assigned to <@${selectedUser}>`,
      blocks: [
        originalSection ?? {
          type: "section",
          text: { type: "mrkdwn", text: `*[Q${queryIndex}]* (question)` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Assigned to <@${selectedUser}>` }],
        },
      ],
    }).catch((err: any) => logger.error("prd_assign_owner chat.update failed:", err));
  }

  try {
    const q = threadCtx?.queries.find((q) => q.index === queryIndex);
    const questionBody = q?.body ?? "(PRD open question)";
    const gdocLink = q?.commentId && docId
      ? `https://docs.google.com/document/d/${docId}/edit?disco=${q.commentId}`
      : "";

    let threadPermalink = "";
    try {
      const plRes = await client.chat.getPermalink({ channel: ctxChannel, message_ts: threadTs });
      threadPermalink = (plRes as any).permalink ?? "";
    } catch { /* best effort */ }

    const dmParts = [
      `You've been assigned to answer a PRD open question:`,
      `> ${questionBody}`,
    ];
    if (gdocLink) dmParts.push(`<${gdocLink}|View in Google Docs>`);
    if (threadPermalink) dmParts.push(`<${threadPermalink}|Go to Slack thread>`);

    const imRes = await client.conversations.open({ users: selectedUser });
    const dmChannel = (imRes as any).channel?.id;
    if (dmChannel) {
      await client.chat.postMessage({ channel: dmChannel, text: dmParts.join("\n") });
    }
  } catch (err: any) {
    logger.error("prd_assign_owner DM failed:", err);
  }
});

// ─── Button action: Approve (mid-run approval gate) ─────────────────────────
app.action("approval_approve", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).value ?? "";
  const [runId, repoId] = raw.split(":");
  if (!runId || !repoId) return;

  const slackUser = (body as any).user?.id ?? "unknown";
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: slackUser }),
    });
    const data = await zeverseResponseJson<{ approved?: boolean; error?: string }>(res, "POST /api/runs/:id/approve");
    if (data.error) {
      await client.chat.postMessage({ channel, text: `Approve failed: ${data.error}` });
      return;
    }
    if (messageTs && channel) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `_Approved by <@${slackUser}>._`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `_Approved by <@${slackUser}>. Workflow continuing..._` } }],
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.error("approval_approve error:", err);
    if (channel) await client.chat.postMessage({ channel, text: `Error: ${err.message}` });
  }
});

// ─── Button action: Reject (mid-run approval gate) ──────────────────────────
app.action("approval_reject", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).value ?? "";
  const [runId, repoId] = raw.split(":");
  if (!runId || !repoId) return;

  const slackUser = (body as any).user?.id ?? "unknown";
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: slackUser }),
    });
    const data = await zeverseResponseJson<{ rejected?: boolean; error?: string }>(res, "POST /api/runs/:id/reject");
    if (data.error) {
      await client.chat.postMessage({ channel, text: `Reject failed: ${data.error}` });
      return;
    }
    if (messageTs && channel) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `_Rejected by <@${slackUser}>. Workflow stopped._`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `_Rejected by <@${slackUser}>. Workflow stopped._` } }],
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.error("approval_reject error:", err);
    if (channel) await client.chat.postMessage({ channel, text: `Error: ${err.message}` });
  }
});

// ─── Bootstrap rules helpers ────────────────────────────────────────────────

async function pollBootstrapRun(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 120;
  const intervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: any;
    try {
      const res = await fetch(
        `${ZEVERSE_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await zeverseResponseJson<any>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const failedStep = state.steps?.find((s: any) => s.status === "failed");
      const errMsg = failedStep
        ? `Step \`${failedStep.id}\` failed: ${failedStep.error ?? "unknown"}`
        : "Run failed (check logs for details)";
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `*Rules bootstrap failed* :x:\n${errMsg}`,
      });
      return;
    }

    const parts: string[] = ["*Rules & skills PR created* :white_check_mark:"];
    if (state.prUrl) {
      parts.push(`<${state.prUrl}|View PR on GitHub>`);
    }
    const summaryStep = state.steps?.find((s: any) => s.id === "summary" && s.status === "success");
    if (summaryStep?.output) {
      parts.push(`\n${summaryStep.output.slice(0, 500)}`);
    }

    await client.chat.postMessage({ channel, thread_ts, text: parts.join("\n") });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text: `Rules bootstrap is still running after ${(maxAttempts * intervalMs) / 1000}s. Check <${ZEVERSE_UI_URL}|Zeverse> for status.`,
  });
}

// ─── Bootstrap rules action ─────────────────────────────────────────────────

app.action("bootstrap_rules", async ({ action, ack, body, client, logger }) => {
  await ack();
  const repoId = (action as any).value;
  if (!repoId) return;

  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  const thread_ts = (body as any).message?.thread_ts ?? messageTs;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `_Generating rules & skills for \`${repoId}\`..._`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Generating rules & skills for \`${repoId}\`..._`,
          },
        },
      ],
    }).catch(() => {});
  }

  try {
    const res = await fetch(
      `${zeverseBaseUrl()}/api/repos/${encodeURIComponent(repoId)}/bootstrap-rules`,
      { method: "POST" }
    );
    const data = await zeverseResponseJson<{ runId?: string; error?: string }>(
      res, "POST /api/repos/:id/bootstrap-rules"
    );
    if (data.error) {
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Failed to start bootstrap: ${data.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Rules bootstrap started (run \`${data.runId}\`). Follow progress in <${ZEVERSE_UI_URL}|Zeverse>.`,
    });

    pollBootstrapRun(data.runId!, repoId, channel, thread_ts, client, logger).catch(
      (err: any) => logger.error("pollBootstrapRun error:", err)
    );
  } catch (err: any) {
    logger.error("bootstrap_rules error:", err);
    if (channel) {
      await client.chat.postMessage({
        channel, thread_ts,
        text: `Error starting bootstrap: ${err.message}`,
      });
    }
  }
});

app.action("open_hub_link", async ({ ack }) => {
  await ack();
});

// ─── Harness thread follow-up ───────────────────────────────────────────────
async function handleHarnessFollowUp(
  ctx: HarnessThreadContext,
  newPrompt: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  handleHarnessMessage(newPrompt, channel, thread_ts, client, logger, "mention", ctx.repoId).catch(
    (err) => logger.error("handleHarnessMessage (follow-up) error:", err)
  );
}

// ─── @mentions ─────────────────────────────────────────────────────────────
// Tag the bot in any channel it's been invited to. The bot now answers
// everything: questions get a direct answer, unclear requests get a clarifying
// question, and clear action intents trigger a workflow.
app.event("app_mention", async ({ event, client, logger }) => {
  const text = (event as any).text ?? "";
  const channel = (event as any).channel as string;
  const thread_ts = (event as any).thread_ts ?? (event as any).ts;

  const stripped = stripMentions(text);

  if (stripped.trim().toLowerCase() === "help") {
    const userId = (event as any).user as string;
    let repoHint: string | null = DEFAULT_REPO_ID.trim() ? DEFAULT_REPO_ID : null;
    if (thread_ts) {
      const h = lookupHarnessThread(channel, thread_ts);
      if (h?.repoId) repoHint = h.repoId;
      else {
        const prd =
          lookupPrdThread(channel, thread_ts) ?? lookupPrdThreadByChannel(channel);
        if (prd?.repoId) repoHint = prd.repoId;
      }
    }
    await postWorkflowHelpEphemeral(client, channel, userId, thread_ts, repoHint, logger);
    return;
  }

  // Intercept add-repo before any other routing
  const addRepoParsed = parseAddRepoCommand(stripped);
  if (addRepoParsed) {
    await handleAddRepoMessage(text, channel, (event as any).user, thread_ts, false, client, logger);
    return;
  }

  // Check if this mention is inside a tracked PRD thread
  if (thread_ts) {
    const intent = parsePrdMentionIntent(stripped);
    if (intent) {
      const prdCtx =
        lookupPrdThread(channel, thread_ts) ??
        lookupPrdThreadByChannel(channel) ??
        discoverPrdContextFromState(channel, thread_ts, logger);
      if (prdCtx) {
        handlePrdThreadMention(prdCtx, intent, channel, thread_ts, client, logger).catch(
          (err) => logger.error("handlePrdThreadMention error:", err)
        );
        return;
      }
    }
  }

  // Check if this mention is inside a tracked harness thread — route follow-up
  if (thread_ts && stripped) {
    const harnessCtx = lookupHarnessThread(channel, thread_ts);
    if (harnessCtx) {
      handleHarnessFollowUp(harnessCtx, stripped, channel, thread_ts, client, logger).catch(
        (err) => logger.error("handleHarnessFollowUp error:", err)
      );
      return;
    }
  }

  // Unified harness handler: answer, clarify, or propose workflow with confirm buttons
  const prompt = stripped || "help";
  handleHarnessMessage(prompt, channel, thread_ts, client, logger, "mention").catch(
    (err) => logger.error("handleHarnessMessage (mention) error:", err)
  );
});

// ─── PRD thread reply → Google Doc suggestion ──────────────────────────────
// When a user replies in a tracked PRD-analysis Slack thread, match their
// answer to an open query and post it as a reply on the Google Doc comment.

type PrdReplyMatch =
  | { queryIndex: number; suggestion: string }
  | { conversational: string }
  | { unresolved: string };

async function matchReplyToQuery(
  userReply: string,
  queries: PrdQueryInfo[],
  repoId: string,
  threadContext: string
): Promise<PrdReplyMatch> {
  // Explicit prefix: highest precision
  const prefixMatch = userReply.match(/^(?:Q|#)\s*(\d+)\b/i);
  if (prefixMatch) {
    const idx = parseInt(prefixMatch[1], 10);
    const matched = queries.find((q) => q.index === idx);
    if (matched) {
      const suggestion = userReply.replace(/^(?:Q|#)\s*\d+[:\s]*/i, "").trim();
      return { queryIndex: idx, suggestion };
    }
  }

  try {
    const route = await callHarnessRoute(
      userReply,
      threadContext,
      repoId,
      "prd_thread",
      { prdQueries: queries.map((q) => ({ index: q.index, body: q.body })) }
    );

    if (route.error) {
      return {
        unresolved: `${route.error} (Couldn't reach the routing model.)`,
      };
    }

    const pm = route.prdThreadMatch;
    const convo =
      (route.answer ?? "").trim() ||
      (pm?.conversationalReply ?? "").trim();

    const idx =
      pm && typeof pm.queryIndex === "number" && pm.queryIndex >= 1
        ? pm.queryIndex
        : null;
    const sug = (pm?.suggestion ?? "").trim();

    if (idx !== null && sug) {
      return { queryIndex: idx, suggestion: sug };
    }

    if (convo) {
      return { conversational: convo };
    }

    return {
      unresolved:
        pm?.noMatchExplanation?.trim() ||
        "I'm not sure which open question you're addressing.",
    };
  } catch (err: any) {
    return {
      unresolved: err?.message
        ? `Routing failed: ${err.message}`
        : "Couldn't classify your reply right now.",
    };
  }
}

async function postGDocReply(
  docId: string,
  commentId: string,
  body: string
): Promise<{ replyId?: string; error?: string }> {
  try {
    const res = await fetch(`${ZEVERSE_SERVER_URL}/api/gdoc-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, commentId, body }),
    });
    return await zeverseResponseJson<{ replyId?: string; error?: string }>(
      res,
      "POST /api/gdoc-reply"
    );
  } catch (err: any) {
    return { error: err.message };
  }
}

app.message(async ({ message, client, logger }) => {
  const m = message as any;
  // Only handle channel thread replies (not DMs, not top-level messages)
  if (m.channel_type === "im") return;
  if (m.subtype || m.bot_id) return;
  if (!m.thread_ts) return;

  // Check for pending debug workflow thread-reply asks first
  const threadAsk = lookupPendingThreadAsk(m.channel, m.thread_ts);
  if (threadAsk) {
    removePendingThreadAsk(m.channel, m.thread_ts);
    await downloadAndForwardThreadReply(threadAsk, m, client, logger);
    return;
  }

  const ctx = lookupPrdThread(m.channel, m.thread_ts) ?? lookupPrdThreadByChannel(m.channel);
  if (!ctx) return;

  const text = (m.text ?? "").trim();
  if (!text) return;

  const threadMsgs = await fetchThreadMessages(m.channel, m.thread_ts, client);
  const prdThreadContext = buildGenericThreadContext(threadMsgs);

  const match = await matchReplyToQuery(text, ctx.queries, ctx.repoId, prdThreadContext);

  const queryList = ctx.queries
    .map((q) => `Q${q.index}: ${sanitizeForSlackMrkdwn(q.body.slice(0, 120))}`)
    .join("\n");

  if ("conversational" in match) {
    const body = formatLLMTextForSlack(match.conversational);
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: body,
    });
    return;
  }

  if ("unresolved" in match) {
    const unresolvedFmt = sanitizeForSlackMrkdwn(match.unresolved);
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `${unresolvedFmt}\n\n` +
        `Open questions:\n${queryList}\n\n` +
        `If you're answering one of these, prefix with \`Q<number>\`, e.g. \`Q1 yes, we should…\`.`,
    });
    return;
  }

  const query = ctx.queries.find((q) => q.index === match.queryIndex);
  if (!query) {
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: `Matched your reply to Q${match.queryIndex}, but I don't have tracking info for it.`,
    });
    return;
  }

  if (query.anchor) {
    const result = await postGDocSuggestEdits(ctx.docId, [
      { anchor: query.anchor, replacement: `${query.anchor}\n\n[Update — Q${query.index}]: ${match.suggestion}` },
    ]);
    if (result.error) {
      logger.error(`Failed to post GDoc suggestion for Q${match.queryIndex}: ${result.error}`);
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: `Matched your reply to Q${match.queryIndex} but failed to post suggestion to Google Doc: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `Posted as a suggested edit on the Google Doc for Q${match.queryIndex}. ` +
        `Open the doc and click *Accept* to apply it. :white_check_mark:\n` +
        `<${ctx.docUrl}|Open PRD>`,
    });
  } else {
    const result = await postGDocComment(
      ctx.docId,
      `[Answer to Q${query.index}]: ${match.suggestion}`,
      query.anchor
    );
    if (result.error) {
      logger.error(`Failed to post GDoc comment for Q${match.queryIndex}: ${result.error}`);
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: `Matched your reply to Q${match.queryIndex} but failed to post to Google Doc: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `Added your answer for Q${match.queryIndex} as a comment on the Google Doc. :white_check_mark:\n` +
        `<${ctx.docUrl}|Open PRD>`,
    });
  }
});

// ─── Direct messages ───────────────────────────────────────────────────────
// Users can DM the bot without a mention. Unified harness handler answers everything.
app.message(async ({ message, client, logger }) => {
  const m = message as any;
  if (m.channel_type !== "im") return;
  if (m.subtype || m.bot_id) return;
  const text = m.text ?? "";

  const stripped = stripMentions(text);
  if (!stripped) return;

  const thread_ts = m.thread_ts ?? m.ts;

  // Intercept add-repo in DMs
  const addRepoParsedDm = parseAddRepoCommand(stripped);
  if (addRepoParsedDm) {
    await handleAddRepoMessage(text, m.channel, m.user!, thread_ts, true, client, logger);
    return;
  }

  handleHarnessMessage(stripped, m.channel, thread_ts, client, logger, "dm").catch(
    (err) => logger.error("handleHarnessMessage (dm) error:", err)
  );
});

(async () => {
  await probeZeverseOnStartup();
  const port = parseInt(process.env.SLACK_BOT_PORT ?? "3200", 10);
  await app.start(port);
  console.log(`Zeverse Slack bot listening on port ${port}`);
})();
