import { Router, Request, Response } from "express";
import { loadConfig } from "../config";
import { findWorkflow } from "../workflows";
import type { WorkflowInput } from "../workflows";
import { extractBranchHint, resolveCheckoutBaseBranch } from "../branch-hint";
import { requireRepo } from "../repos";
import { startRun, getActiveRun, resolveApproval, rejectApproval, resolveThreadReply } from "../runner";
import { findStateByRunId, loadState, readLog, readEvents, appendEvent } from "../runner/state";
import { extractDocId, replyToComment, addComment, suggestEdits } from "../integrations/gdocs";

export const runRoutes = Router();

// Regex-based extractors for known workflow input ids. Applied only when the
// workflow declares the input and the caller didn't already set it. Keeps the
// Slack / harness / UI / curl paths in sync for common shapes like Freshrelease
// task URLs, GitHub PR URLs, and Google Doc URLs.
const INPUT_EXTRACTORS: Record<string, (text: string) => string | undefined> = {
  frUrl: (t) =>
    t.match(/https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)<>]+/i)?.[0] ??
    t.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0],
  docUrl: (t) =>
    t.match(/https?:\/\/docs\.google\.com\/document\/[^\s)<>]+/i)?.[0] ??
    t.match(/https?:\/\/[^\s)<>]*(?:atlassian\.net\/wiki|confluence\.)[^\s)<>]*/i)?.[0] ??
    t.match(/https?:\/\/[^\s)<>]*\/spaces\/[^/]+\/pages\/\d+[^\s)<>]*/i)?.[0],
  pr: (t) =>
    t.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+[^\s)<>]*/i)?.[0] ??
    t.match(/(?:^|\s)#(\d+)(?:\s|$)/)?.[1],
  branch: (t) => extractBranchHint(t),
};

function autofillInputs(
  declared: WorkflowInput[],
  current: Record<string, string>,
  prompt: string
): Record<string, string> {
  if (!prompt) return current;
  const next = { ...current };
  for (const def of declared) {
    const already = (next[def.id] ?? "").trim();
    if (already) continue;
    const extractor = INPUT_EXTRACTORS[def.id];
    if (!extractor) continue;
    const value = extractor(prompt);
    if (value) next[def.id] = value;
  }
  return next;
}

runRoutes.post("/run-workflow", async (req: Request, res: Response) => {
  try {
    const { repoId, workflow: workflowName, prompt, inputs, baseBranch } = req.body ?? {};

    if (!repoId) {
      res.status(400).json({ error: "repoId is required" });
      return;
    }
    if (!workflowName) {
      res.status(400).json({ error: "workflow is required" });
      return;
    }

    const repo = requireRepo(repoId);
    const workflow = findWorkflow(repo, workflowName);
    if (!workflow) {
      res
        .status(404)
        .json({ error: `Workflow "${workflowName}" not found in repo "${repoId}"` });
      return;
    }

    const config = loadConfig();
    const baseInputs: Record<string, string> = {
      ...(inputs ?? {}),
      requirement: inputs?.requirement ?? prompt ?? "",
    };
    const mergedInputs = autofillInputs(workflow.inputs, baseInputs, prompt ?? "");
    if (workflowName === "test-fix" && !(mergedInputs.test_command ?? "").trim()) {
      mergedInputs.test_command = "npm install --legacy-peer-deps && npm run test";
    }

    const resolvedBranch = resolveCheckoutBaseBranch(
      workflow,
      mergedInputs,
      baseBranch,
      prompt ?? "",
      repo.id
    );
    const runId = await startRun(repo, workflow, prompt ?? "", mergedInputs, config, resolvedBranch);
    res.json({ runId, repoId: repo.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

runRoutes.get("/runs/:id", (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const repoId = req.query.repoId ? String(req.query.repoId) : undefined;

  const state =
    getActiveRun(id) ??
    (repoId ? loadState(repoId, id) : findStateByRunId(id));

  if (!state) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(state);
});

runRoutes.get("/logs/:id", (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const offset = parseInt(String(req.query.offset ?? "0"), 10);
  let repoId = req.query.repoId ? String(req.query.repoId) : undefined;

  if (!repoId) {
    const state = findStateByRunId(id);
    repoId = state?.repoId;
  }
  if (!repoId) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const { content, nextOffset } = readLog(repoId, id, offset);
  res.json({ content, nextOffset });
});

runRoutes.get("/runs/:id/events", (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const offset = parseInt(String(req.query.offset ?? "0"), 10);
  let repoId = req.query.repoId ? String(req.query.repoId) : undefined;

  if (!repoId) {
    const state = getActiveRun(id) ?? findStateByRunId(id);
    repoId = state?.repoId;
  }
  if (!repoId) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const { content, nextOffset } = readEvents(repoId, id, offset);
  res.json({ content, nextOffset });
});

runRoutes.post("/runs/:id/approve", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const { by, comment } = req.body ?? {};
  if (!by) {
    res.status(400).json({ error: "by is required" });
    return;
  }
  const ok = resolveApproval(id, by, comment);
  if (!ok) {
    res.status(404).json({ error: "No pending approval for this run" });
    return;
  }
  res.json({ approved: true, by, runId: id });
});

runRoutes.post("/runs/:id/reject", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const { by, reason } = req.body ?? {};
  if (!by) {
    res.status(400).json({ error: "by is required" });
    return;
  }
  const ok = rejectApproval(id, by, reason);
  if (!ok) {
    res.status(404).json({ error: "No pending approval for this run" });
    return;
  }
  res.json({ rejected: true, by, runId: id });
});

runRoutes.post("/runs/:id/thread-reply", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const { by, text, files } = req.body ?? {};
  if (!by) {
    res.status(400).json({ error: "by is required" });
    return;
  }
  const ok = resolveThreadReply(id, {
    by,
    text: text ?? "",
    files: Array.isArray(files) ? files : [],
  });
  if (!ok) {
    res.status(404).json({ error: "No pending thread-reply wait for this run" });
    return;
  }
  res.json({ resumed: true, by, runId: id });
});

runRoutes.post("/gdoc-reply", async (req: Request, res: Response) => {
  try {
    const { docId: rawDocId, commentId, body } = req.body ?? {};
    if (!rawDocId || !commentId || !body) {
      res.status(400).json({ error: "docId, commentId, and body are required" });
      return;
    }
    const docId = extractDocId(rawDocId);
    const result = await replyToComment(docId, commentId, body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Without `anchor`, Drive creates an unanchored (document-level) comment.
// Pass a verbatim substring from the doc body for highlighted threads (`?disco=` links).
runRoutes.post("/gdoc-comment", async (req: Request, res: Response) => {
  try {
    const { docId: rawDocId, body, anchor } = req.body ?? {};
    if (!rawDocId || !body) {
      res.status(400).json({ error: "docId and body are required" });
      return;
    }
    const docId = extractDocId(rawDocId);
    const anchorStr =
      typeof anchor === "string" && anchor.trim() ? anchor.trim() : undefined;
    const result = await addComment(docId, body, {
      quotedAnchor: anchorStr,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

runRoutes.post("/gdoc-suggest", async (req: Request, res: Response) => {
  try {
    const { docId: rawDocId, edits } = req.body ?? {};
    if (!rawDocId || !Array.isArray(edits)) {
      res.status(400).json({ error: "docId and edits[] are required" });
      return;
    }
    const docId = extractDocId(rawDocId);
    const result = await suggestEdits(docId, edits);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
