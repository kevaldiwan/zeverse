/**
 * Thin shim — delegates to /api/harness/route and reshapes the response
 * into the legacy RouteIntentResponse format so the UI keeps working.
 */
import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import { loadWorkflows } from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";

export const routeIntentRoutes = Router();

interface RouteIntentResponse {
  repoId: string | null;
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
  fallback: boolean;
}

const FALLBACK_WORKFLOW = "ask";

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

async function inferRepoId(prompt: string): Promise<string | null> {
  const repos = listRepos();
  if (repos.length === 0) return null;
  if (repos.length === 1) return repos[0].id;

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
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const repoId = typeof parsed.repoId === "string" ? parsed.repoId : null;
    if (repoId && !repos.some((r) => r.id === repoId)) return null;
    return repoId;
  } catch {
    return null;
  }
}

routeIntentRoutes.post("/route-intent", async (req: Request, res: Response) => {
  try {
    const { prompt, repoId: requestedRepoId } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    let repoId: string | null = requestedRepoId ?? null;

    if (!repoId) {
      repoId = await inferRepoId(prompt);
    }

    if (!repoId) {
      res.json({
        repoId: null,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: "Could not determine repo",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    let repo;
    try {
      repo = requireRepo(repoId);
    } catch {
      res.json({
        repoId: null,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: `Repo "${repoId}" not found`,
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    const workflows = loadWorkflows(repo);
    if (workflows.length === 0) {
      res.json({
        repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: "No workflows found in repo",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    const workflowNames = new Set(workflows.map((w) => w.name));
    const keywordWorkflow = matchWorkflowKeyword(prompt, workflowNames);
    if (keywordWorkflow) {
      const frNeedsUrl =
        keywordWorkflow === "fr-analyze" || keywordWorkflow === "fr-task-finisher";
      const frUrl = extractFreshreleaseTaskUrl(prompt);
      if (!frNeedsUrl || frUrl) {
        const inputs: Record<string, string> = { requirement: prompt };
        if (frNeedsUrl && frUrl) inputs.frUrl = frUrl;
        res.json({
          repoId,
          workflow: keywordWorkflow,
          inputs,
          confidence: 0.95,
          reason: `Keyword routing → ${keywordWorkflow}`,
          fallback: false,
        } satisfies RouteIntentResponse);
        return;
      }
    }

    // Delegate to harness route internally
    const harnessUrl = `http://localhost:${process.env.ZEVERSE_SERVER_PORT ?? "3100"}/api/harness/route`;
    const harnessRes = await fetch(harnessUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, repoId }),
    });
    const harnessData = await harnessRes.json() as any;

    if (harnessData.type === "proposal" || harnessData.type === "answer_with_proposal") {
      res.json({
        repoId: harnessData.repoId,
        workflow: harnessData.workflow,
        inputs: harnessData.inputs ?? { requirement: prompt },
        confidence: harnessData.confidence ?? 0,
        reason: harnessData.reason ?? "",
        fallback: false,
      } satisfies RouteIntentResponse);
    } else {
      res.json({
        repoId: harnessData.repoId ?? repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: { requirement: prompt },
        confidence: harnessData.confidence ?? 0,
        reason: harnessData.reason ?? harnessData.answer ?? "",
        fallback: true,
      } satisfies RouteIntentResponse);
    }
  } catch (err: any) {
    res.status(500).json({
      error: `Route-intent failed: ${err.message}`,
      workflow: FALLBACK_WORKFLOW,
      fallback: true,
    });
  }
});
