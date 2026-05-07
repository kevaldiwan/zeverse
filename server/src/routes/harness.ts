import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import {
  loadWorkflows,
  findWorkflow,
  loadRepoRules,
  type Workflow,
} from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";
import { extractBranchHint, resolveCheckoutBaseBranch, workflowDeclaresBranchInput } from "../branch-hint";
import { extractPrdDocUrl } from "../prd-doc-url";
import { startRun, runSingleStep } from "../runner";
import { assertAllowed, appendAuditLog, PolicyError } from "../policy";
import {
  mapUnifiedParsedToHarnessResponse,
  mapPrdThreadParsedToHarnessResponse,
  type HarnessRouteSuggestion,
} from "./harness-route-map";

export type { HarnessRouteSuggestion };

export const harnessRoutes = Router();

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

interface HarnessRouteResponse {
  type: "proposal" | "answer" | "answer_with_proposal" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  /** Top 1–3 workflow picks (first entry matches `workflow` / `inputs` / `confidence` / `reason`). */
  suggestions?: HarnessRouteSuggestion[];
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  /** Contextual follow-up when `type` is clarify (may duplicate `question`). */
  clarifyingQuestion?: string;
  missing?: string[];
  /** PRD thread reply routing (Slack); see `surface: prd_thread`. */
  prdThreadMatch?: {
    queryIndex: number | null;
    suggestion: string | null;
    conversationalReply?: string;
    noMatchExplanation?: string;
  };
}

const CONFIDENCE_THRESHOLD = 0.6;

/** Slack Block Kit `static_select` allows at most 100 options per menu. */
const MAX_PROPOSAL_ALTERNATIVES = 100;

/** Names for “Pick another…” minus meta-router `harness` and every suggested workflow. */
function proposalAlternativesExcluding(
  workflows: Workflow[],
  excludeNames: string[]
): string[] {
  const ex = new Set(excludeNames);
  const names = workflows
    .map((w) => w.name)
    .filter((name) => name !== "harness" && !ex.has(name))
    .sort((a, b) => a.localeCompare(b));
  return names.slice(0, MAX_PROPOSAL_ALTERNATIVES);
}

function toSuggestionEntry(
  entry: any,
  prompt: string,
  workflowNames: Set<string>
): HarnessRouteSuggestion | null {
  const wf = typeof entry?.workflow === "string" ? entry.workflow : "";
  if (!workflowNames.has(wf)) return null;
  const confidence = typeof entry?.confidence === "number" ? entry.confidence : 0;
  if (confidence < CONFIDENCE_THRESHOLD) return null;
  const reason = typeof entry?.reason === "string" ? entry.reason : "";
  const routeInputsParsed =
    typeof entry?.inputs === "object" && entry.inputs ? entry.inputs : {};
  return {
    workflow: wf,
    inputs: { requirement: prompt, ...routeInputsParsed },
    confidence,
    reason,
  };
}

function dedupeSuggestions(s: HarnessRouteSuggestion[]): HarnessRouteSuggestion[] {
  const byWf = new Map<string, HarnessRouteSuggestion>();
  for (const x of s) {
    const prev = byWf.get(x.workflow);
    if (!prev || x.confidence > prev.confidence) byWf.set(x.workflow, x);
  }
  return [...byWf.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * From harness.yaml route step JSON or server LLM JSON: `suggestions: [...]` (preferred)
 * or legacy single `workflow` / `inputs` / `confidence` / `reason`.
 */
function buildTopSuggestionsFromParsed(
  parsed: any,
  prompt: string,
  workflowNames: Set<string>
): HarnessRouteSuggestion[] {
  if (Array.isArray(parsed?.suggestions) && parsed.suggestions.length > 0) {
    const out: HarnessRouteSuggestion[] = [];
    for (const s of parsed.suggestions) {
      const e = toSuggestionEntry(s, prompt, workflowNames);
      if (e) out.push(e);
    }
    return dedupeSuggestions(out).slice(0, 3);
  }
  const e = toSuggestionEntry(
    {
      workflow: parsed?.workflow,
      inputs: parsed?.inputs,
      confidence: parsed?.confidence,
      reason: parsed?.reason,
    },
    prompt,
    workflowNames
  );
  return e ? [e] : [];
}

async function inferRepoId(prompt: string): Promise<{ repoId: string | null; reason: string }> {
  const repos = listRepos();
  if (repos.length === 0) return { repoId: null, reason: "No repos registered" };
  if (repos.length === 1) return { repoId: repos[0].id, reason: "Only one repo registered" };

  const repoList = repos
    .map((r) => `- id: ${r.id} | name: ${r.name} | origin: ${r.origin ?? "local"}`)
    .join("\n");

  const llm = createLLMProvider(loadConfig());
  const response = await llm.chat([
    {
      role: "system",
      content: [
        "You pick the best-matching repository for a user request.",
        'Respond with ONLY a JSON object: { "repoId": "<id>" | null, "reason": "<short reason>" }',
        "Return null for repoId if the request doesn't clearly match any repo.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Available repos:\n${repoList}\n\nUser request: ${prompt}`,
    },
  ]);

  const text = response.content.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { repoId: null, reason: "LLM did not return valid JSON" };

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const repoId = typeof parsed.repoId === "string" ? parsed.repoId : null;
    if (repoId && !repos.some((r) => r.id === repoId)) {
      return { repoId: null, reason: `LLM returned unknown repo id: ${repoId}` };
    }
    return { repoId, reason: parsed.reason ?? "" };
  } catch {
    return { repoId: null, reason: "Failed to parse LLM JSON" };
  }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * POST /api/harness/route
 *
 * Unified routing: repo pick -> keyword shortcut -> harness.yaml dry-run -> proposal/answer/clarify.
 */
harnessRoutes.post("/harness/route", async (req: Request, res: Response) => {
  try {
    const { prompt, repoId: requestedRepoId, threadContext, surface, prdQueries: prdQueriesRaw } =
      req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    let repoId: string | null = requestedRepoId ?? null;

    if (!repoId) {
      const inferred = await inferRepoId(prompt);
      repoId = inferred.repoId;
    }

    if (!repoId) {
      const repos = listRepos();
      if (repos.length === 0) {
        res.json({
          type: "clarify",
          repoId: null,
          question: "No repositories are registered. Import a repo first.",
          missing: ["repoId"],
          confidence: 0,
          reason: "No repos available",
        } satisfies HarnessRouteResponse);
      } else {
        res.json({
          type: "clarify",
          repoId: null,
          question: `Which repository should I work with?\n${repos.map((r) => `- \`${r.id}\`: ${r.name}`).join("\n")}`,
          missing: ["repoId"],
          confidence: 0,
          reason: "Could not determine repo from prompt",
        } satisfies HarnessRouteResponse);
      }
      return;
    }

    let repo;
    try {
      repo = requireRepo(repoId);
    } catch {
      res.json({
        type: "clarify",
        repoId: null,
        question: `Repo "${repoId}" not found. Which repo should I use?`,
        missing: ["repoId"],
        confidence: 0,
        reason: `Repo "${repoId}" not found`,
      } satisfies HarnessRouteResponse);
      return;
    }

    const workflows = loadWorkflows(repo);
    const workflowNames = new Set(workflows.map((w) => w.name));

    if (workflows.length === 0) {
      res.json({
        type: "answer",
        repoId,
        answer: [
          "No workflow files found for this repo in the hub cache.",
          "",
          `Zeverse only reads \`.zeverse/workflows/*.yaml\` from **one Git branch**: the \`defaultBranch\` stored for this repo (\`${repo.defaultBranch}\` from \`origin\` ${repo.origin}).`,
          "",
          "If you added workflows locally, **push them to that branch** (or change \`defaultBranch\` in \`repos.json\` to match the branch that contains \`.zeverse/\`, then save).",
          "",
          `After the remote is updated, refresh the cache: \`POST /api/repos/${repoId}/refresh-workflows\` (or wait ~60s).`,
        ].join("\n"),
        confidence: 0,
        reason: "No workflows found in repo",
      } satisfies HarnessRouteResponse);
      return;
    }

    const allWorkflowNames = workflows.map((w) => w.name);

    // PRD Slack-thread reply assistant (never use keyword shortcuts here)
    if (
      surface === "prd_thread" &&
      Array.isArray(prdQueriesRaw) &&
      prdQueriesRaw.length > 0
    ) {
      const prdQueries = (
        prdQueriesRaw as { index?: unknown; body?: unknown }[]
      ).filter((q) => q && typeof q.index === "number" && typeof q.body === "string");

      if (prdQueries.length > 0) {
        const repoRules = loadRepoRules(repo);
        const llmPrd = createLLMProvider(loadConfig());
        const openList = prdQueries
          .map((q) => `Q${q.index}: ${q.body}`)
          .join("\n");

        const prdSystem = [
          "You assist with Slack replies in a PRD (product requirements) analysis thread tied to Google Doc comments.",
          "Given open numbered questions and the user's latest Slack message, decide what to do.",
          "",
          "Respond with ONLY a JSON object (no markdown fences, no prose):",
          "{",
          '  "matchIndex": <0 if none, else the question number matching one of the listed Q numbers>,',
          '  "suggestionForDoc": "<concise text suitable as a Google Doc comment reply when matchIndex>0; empty string otherwise>",',
          '  "conversationalReply": "<Slack-ready reply when the user is NOT answering any listed question but needs a human-like answer; empty string otherwise>",',
          '  "noMatchExplanation": "<one short sentence when matchIndex is 0 and conversationalReply is empty; why you could not map the reply>"',
          "}",
          "",
          "Rules:",
          "- If the user clearly answers one question, set matchIndex to that Q number and fill suggestionForDoc.",
          "- If they ask something else or discuss generally, use conversationalReply and keep matchIndex 0.",
          "- Never invent Q numbers that were not listed.",
          ...(repoRules
            ? ["", `Repo conventions for ${repoId} (optional context):`, repoRules]
            : []),
        ].join("\n");

        const prdUser = [
          `Open PRD questions:\n${openList}`,
          threadContext ? `\nSlack thread so far:\n${threadContext}` : "",
          `\nLatest user Slack reply:\n${prompt}`,
        ].join("\n");

        const prdResp = await llmPrd.chat([
          { role: "system", content: prdSystem },
          { role: "user", content: prdUser },
        ]);
        let prdParsed = extractJsonObject(prdResp.content);
        if (!prdParsed) {
          const prdRetry = await llmPrd.chat([
            { role: "system", content: prdSystem },
            { role: "user", content: prdUser },
            {
              role: "user",
              content:
                "Your last response was not valid JSON. Reply again with ONLY the JSON object described in the system message.",
            },
          ]);
          prdParsed = extractJsonObject(prdRetry.content) ?? {};
        }

        const prdOut = mapPrdThreadParsedToHarnessResponse({
          parsed: prdParsed,
          repoId,
        });
        res.json(prdOut satisfies HarnessRouteResponse);
        return;
      }
    }

    // 1. Keyword shortcut for high-confidence matches
    const keywordWorkflow = matchWorkflowKeyword(prompt, workflowNames);
    if (keywordWorkflow) {
      const frUrl = extractFreshreleaseTaskUrl(prompt);
      const inputs: Record<string, string> = { requirement: prompt };
      if (frUrl) inputs.frUrl = frUrl;
      if (keywordWorkflow === "prd-analysis") {
        const docUrl = extractPrdDocUrl(prompt);
        if (docUrl) inputs.docUrl = docUrl;
      }
      if (keywordWorkflow === "test" || keywordWorkflow === "test-fix") {
        const bh = extractBranchHint(prompt, repoId);
        if (bh) inputs.branch = bh;
      }

      const reason = `Keyword routing → ${keywordWorkflow}`;
      res.json({
        type: "proposal",
        repoId,
        workflow: keywordWorkflow,
        inputs,
        suggestions: [
          {
            workflow: keywordWorkflow,
            inputs: { ...inputs },
            confidence: 0.95,
            reason,
          },
        ],
        alternatives: proposalAlternativesExcluding(workflows, [keywordWorkflow]),
        confidence: 0.95,
        reason,
      } satisfies HarnessRouteResponse);
      return;
    }

    // 2. Try harness.yaml dry-run if the repo has one
    const harnessWf = findWorkflow(repo, "harness");
    if (harnessWf) {
      const routeStep = harnessWf.steps.find((s) => s.id === "route");
      if (routeStep) {
        try {
          const config = loadConfig();
          const inputs: Record<string, string> = { requirement: prompt };
          if (threadContext) inputs.threadContext = threadContext;

          const catalogStep = harnessWf.steps.find((s) => s.id === "catalog");
          let catalogOutput = "";
          if (catalogStep) {
            try {
              catalogOutput = await runSingleStep(repo, harnessWf, "catalog", inputs, config);
            } catch {
              catalogOutput = workflows
                .filter((w) => w.name !== "harness")
                .map((w) => `- ${w.name}: ${w.description}`)
                .join("\n");
            }
          }

          const routeInputs = { ...inputs, catalog: catalogOutput };
          const routeOutput = await runSingleStep(repo, harnessWf, "route", routeInputs, config);

          const jsonMatchDry = routeOutput.match(/\{[\s\S]*\}/);
          if (jsonMatchDry) {
            let parsedDry: Record<string, unknown>;
            try {
              parsedDry = JSON.parse(jsonMatchDry[0]) as Record<string, unknown>;
            } catch {
              parsedDry = {};
            }

            const suggestionsDry = buildTopSuggestionsFromParsed(
              parsedDry,
              prompt,
              workflowNames
            );
            const wfName =
              typeof parsedDry.workflow === "string" ? parsedDry.workflow : "ask";
            const confidenceDry =
              typeof parsedDry.confidence === "number" ? parsedDry.confidence : 0;
            const reasonDry =
              typeof parsedDry.reason === "string" ? parsedDry.reason : "";

            if (suggestionsDry.length === 0) {
              const mappedDry = mapUnifiedParsedToHarnessResponse({
                parsed: parsedDry,
                prompt,
                suggestionsBuilt: suggestionsDry,
                workflowNames,
                allWorkflowNames,
                repoId,
                confidenceFallback: confidenceDry,
                reasonFallback: reasonDry,
                wfNameParsed: wfName,
                dryRunSuggestionsEmptyFallThrough: true,
              });
              if (mappedDry) {
                res.json(mappedDry satisfies HarnessRouteResponse);
                return;
              }
            } else {
              const mappedWithAnswer = mapUnifiedParsedToHarnessResponse({
                parsed: parsedDry,
                prompt,
                suggestionsBuilt: suggestionsDry,
                workflowNames,
                allWorkflowNames,
                repoId,
                confidenceFallback: confidenceDry,
                reasonFallback: reasonDry,
                wfNameParsed: wfName,
                dryRunSuggestionsEmptyFallThrough: false,
              });
              if (mappedWithAnswer?.type === "answer_with_proposal") {
                res.json(mappedWithAnswer satisfies HarnessRouteResponse);
                return;
              }

              const primary = suggestionsDry[0];
              const selectedNames = suggestionsDry.map((s) => s.workflow);
              res.json({
                type: "proposal",
                repoId,
                workflow: primary.workflow,
                inputs: primary.inputs,
                suggestions: suggestionsDry,
                alternatives: proposalAlternativesExcluding(workflows, selectedNames),
                confidence: primary.confidence,
                reason: primary.reason,
              } satisfies HarnessRouteResponse);
              return;
            }
          }
        } catch {
          // fall through to server-side LLM routing
        }
      }
    }

    // 3. Server-side unified LLM: intent + conversational answer + optional workflow suggestions
    const workflowCatalog = workflows
      .filter((w) => w.name !== "harness")
      .map((w) => {
        const inputList = w.inputs
          .map((inp) => `${inp.id}${inp.required ? " (required)" : ""}: ${inp.label}`)
          .join("; ");
        return `- name: ${w.name} | description: ${w.description} | inputs: [${inputList}]`;
      })
      .join("\n");

    const repoRules = loadRepoRules(repo);

    const llm = createLLMProvider(loadConfig());
    const systemParts = [
      "You are a smart assistant for a software development workflow hub (Zeverse).",
      "Read the user's latest message using the full Slack thread context when provided.",
      "Decide intent, answer conversationally when they are asking questions, and/or suggest workflows when they want automation.",
      "",
      "Respond with ONLY a JSON object (no markdown fences, no prose):",
      "{",
      '  "intent": "action" | "question" | "ambiguous",',
      '  "answer": "<helpful reply; non-empty when intent is question OR when mixed; use repo rules below; empty only if intent is pure action>",',
      '  "clarifyingQuestion": "<non-empty only when intent is ambiguous; MUST reference words from the user message>",',
      '  "suggestions": [',
      '    { "workflow": "<name>", "inputs": { "<inputId>": "<value>", ... }, "confidence": <0.0-1.0>, "reason": "<short>" },',
      "    ... 0 to 3",
      "  ],",
      '  "workflow": "<same as first suggestion; backward compatibility>",',
      '  "inputs": { ... },',
      '  "confidence": <number>,',
      '  "reason": "<string>"',
      "}",
      "",
      "Rules:",
      '- intent "action": user wants automation (fix, test, review, PRD analysis, etc.) — include suggestions with confidence 0.6+ for each good match.',
      '- intent "question": user wants explanation, guidance, or discussion — always include a non-empty "answer" grounded in thread context and repo rules.',
      '- intent "ambiguous": you need one specific follow-up — put it in "clarifyingQuestion" (not generic boilerplate).',
      '- If the user both asks something AND a workflow would help, set intent to "question", fill "answer", and include a strong suggestion (confidence 0.6+).',
      "- confidence 0.9+: clear match; 0.6-0.9: reasonable; omit entries below 0.6.",
      '- Put the main user text in input "requirement" when mapping to workflows.',
      "- ONLY use workflow names from the provided list.",
    ];
    if (repoRules) {
      systemParts.push(
        "",
        `Repo rules and conventions for ${repoId} (use for answers and routing):`,
        repoRules,
      );
    }

    const userContent = [
      `Available workflows:\n${workflowCatalog}`,
      threadContext ? `\nThread context:\n${threadContext}` : "",
      `\nUser prompt:\n${prompt}`,
    ].join("\n");

    const runUnified = async (extraUser?: string) => {
      const messages: { role: "system" | "user"; content: string }[] = [
        { role: "system", content: systemParts.join("\n") },
        { role: "user", content: userContent },
      ];
      if (extraUser) messages.push({ role: "user", content: extraUser });
      const response = await llm.chat(messages);
      return response.content.trim();
    };

    let text = await runUnified();
    let parsed = extractJsonObject(text);
    if (!parsed) {
      res.json({
        type: "answer",
        repoId,
        answer: text
          ? text
          : [`You wrote: _${prompt}_`, "", "I could not parse a structured reply; try rephrasing or naming a concrete task."].join(
              "\n"
            ),
        confidence: 0,
        reason: "LLM did not return valid JSON",
      } satisfies HarnessRouteResponse);
      return;
    }

    let suggestions = buildTopSuggestionsFromParsed(parsed as any, prompt, workflowNames);
    const workflow = typeof parsed.workflow === "string" ? parsed.workflow : "ask";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    let mapped = mapUnifiedParsedToHarnessResponse({
      parsed,
      prompt,
      suggestionsBuilt: suggestions,
      workflowNames,
      allWorkflowNames,
      repoId,
      confidenceFallback: confidence,
      reasonFallback: reason,
      wfNameParsed: workflow,
      dryRunSuggestionsEmptyFallThrough: false,
    });

    const emptyAnswer = (m: typeof mapped) =>
      m &&
      m.type === "answer" &&
      !(m.answer ?? "").trim() &&
      !m.prdThreadMatch;

    const emptyClarify = (m: typeof mapped) =>
      m && m.type === "clarify" && !(m.question ?? "").trim();

    if (!mapped || emptyAnswer(mapped) || emptyClarify(mapped)) {
      text = await runUnified(
        "Your previous JSON was incomplete. Respond again with valid JSON only: " +
          "for intent question include a non-empty answer that addresses the user's exact question; " +
          "for ambiguous include a non-empty clarifyingQuestion that quotes or paraphrases their words; " +
          "for action include at least one suggestion with confidence 0.6+ when a workflow applies."
      );
      const parsed2 = extractJsonObject(text);
      if (parsed2) {
        parsed = parsed2;
        suggestions = buildTopSuggestionsFromParsed(parsed as any, prompt, workflowNames);
        mapped = mapUnifiedParsedToHarnessResponse({
          parsed,
          prompt,
          suggestionsBuilt: suggestions,
          workflowNames,
          allWorkflowNames,
          repoId,
          confidenceFallback:
            typeof parsed.confidence === "number" ? parsed.confidence : 0,
          reasonFallback: typeof parsed.reason === "string" ? parsed.reason : "",
          wfNameParsed: typeof parsed.workflow === "string" ? parsed.workflow : "ask",
          dryRunSuggestionsEmptyFallThrough: false,
        });
      }
    }

    if (!mapped || emptyAnswer(mapped) || emptyClarify(mapped)) {
      mapped = {
        type: "answer",
        repoId,
        answer: [
          `You asked: _${prompt}_`,
          "",
          "I couldn't generate a helpful reply this time. Try adding more detail, or name the repo workflow you want (e.g. fix bug, run tests, code review).",
        ].join("\n"),
        confidence: 0,
        reason: "Empty LLM fields after retry",
      };
    }

    res.json(mapped satisfies HarnessRouteResponse);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("[harness/route]", msg, err);
    res.status(500).json({
      error: `Harness route failed: ${msg}`,
      type: "answer",
      answer:
        `Something went wrong while routing your request.\n\n` +
        `*Detail:* ${msg}\n\n` +
        `Typical causes: LLM/API misconfiguration (check CLOUDVERSE_* / server logs), ` +
        `workflow cache clone failure, or invalid YAML in \`.zeverse/workflows/\`.`,
    });
  }
});

/**
 * POST /api/harness/execute
 *
 * Execute a confirmed workflow. This keeps the run visible under its real
 * workflow name (fix-bug, dev, etc.) rather than wrapping in a harness run.
 */
harnessRoutes.post("/harness/execute", async (req: Request, res: Response) => {
  try {
    const {
      repoId, workflow: workflowName, inputs, prompt,
      slackUser, channel, surface, baseBranch, threadContext,
    } = req.body ?? {};

    if (!repoId) {
      res.status(400).json({ error: "repoId is required" });
      return;
    }
    if (!workflowName) {
      res.status(400).json({ error: "workflow is required" });
      return;
    }

    // Policy check
    try {
      assertAllowed({ repoId, workflow: workflowName, channel, slackUser });
    } catch (err) {
      if (err instanceof PolicyError) {
        res.status(403).json({ error: err.reason, reason: err.reason });
        return;
      }
      throw err;
    }

    const repo = requireRepo(repoId);
    const workflow = findWorkflow(repo, workflowName);
    if (!workflow) {
      res
        .status(404)
        .json({ error: `Workflow "${workflowName}" not found in repo "${repoId}"` });
      return;
    }

    // Input validation
    const mergedInputs: Record<string, string> = {
      ...(inputs ?? {}),
      requirement: inputs?.requirement ?? prompt ?? "",
    };

    let runPrompt = (prompt ?? "").trim();
    if (typeof threadContext === "string" && threadContext.trim()) {
      const tc = threadContext.trim();
      mergedInputs.threadContext = tc;
      runPrompt = `${tc}\n\n--- USER REQUEST ---\n${runPrompt}`;
    }

    const frUrl = extractFreshreleaseTaskUrl(prompt ?? "");
    if (frUrl && !mergedInputs.frUrl) mergedInputs.frUrl = frUrl;

    if (workflowName === "prd-analysis" && !(mergedInputs.docUrl ?? "").trim()) {
      const docUrl =
        extractPrdDocUrl(prompt ?? "") || extractPrdDocUrl(mergedInputs.requirement ?? "");
      if (docUrl) mergedInputs.docUrl = docUrl;
    }

    if (workflowName === "test-fix" && !(mergedInputs.test_command ?? "").trim()) {
      mergedInputs.test_command = "npm install --legacy-peer-deps && npm run test";
    }

    if (!(mergedInputs.branch ?? "").trim()) {
      const hint = extractBranchHint(prompt ?? "", repoId);
      if (hint && workflowDeclaresBranchInput(workflow)) {
        mergedInputs.branch = hint;
      }
    }

    const missing = workflow.inputs
      .filter((inp) => inp.required && !(mergedInputs[inp.id] ?? "").trim())
      .map((inp) => inp.id);

    if (missing.length > 0) {
      res.status(400).json({
        error: `Missing required inputs: ${missing.join(", ")}`,
        missing,
      });
      return;
    }

    const config = loadConfig();
    const resolvedBranch = resolveCheckoutBaseBranch(
      workflow,
      mergedInputs,
      baseBranch,
      prompt ?? "",
      repoId
    );
    const runId = await startRun(
      repo,
      workflow,
      runPrompt || (prompt ?? ""),
      mergedInputs,
      config,
      resolvedBranch
    );

    // Audit log
    appendAuditLog({
      ts: new Date().toISOString(),
      slackUser,
      channel,
      repoId: repo.id,
      workflow: workflowName,
      runId,
      surface,
    });

    res.json({ runId, repoId: repo.id, workflow: workflowName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
