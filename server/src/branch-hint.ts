import type { Workflow } from "./workflows";

/** True when workflow YAML declares optional/required `branch` input (checkout resolution). */
export function workflowDeclaresBranchInput(workflow: Workflow): boolean {
  return workflow.inputs.some((i) => i.id === "branch");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract git branch hints from free text (keyword routing, curl prompts).
 * Conservative patterns only — avoids guessing generic "on X" phrases.
 *
 * Optional **repoId**: interprets `repoId <token> run tests` / `repoId <token> test`
 * as branch `<token>` (ambiguous vs Jest path patterns — prefer `branch=` when both apply).
 */
export function extractBranchHint(prompt: string, repoId?: string): string | undefined {
  const t = prompt.trim();
  if (!t) return undefined;

  const eq = t.match(/\bbranch=([^\s]+)/i);
  if (eq?.[1]) return eq[1];

  const branchWord = t.match(/\bbranch\s+([\w./-]+)\b/i);
  if (branchWord?.[1]) return branchWord[1];

  const onBranch = t.match(/\bon\s+(?:the\s+)?branch\s+([\w./-]+)\b/i);
  if (onBranch?.[1]) return onBranch[1];

  const onWordBranch = t.match(/\bon\s+([\w./-]+)\s+branch\b/i);
  if (onWordBranch?.[1]) return onWordBranch[1];

  const rid = repoId?.trim();
  if (rid) {
    const scoped = new RegExp(
      `\\b${escapeRegex(rid)}\\s+([\\w./-]+)\\s+(?:run\\s+tests?|test)\\b`,
      "i"
    ).exec(t);
    if (scoped?.[1]) return scoped[1];
  }

  return undefined;
}

/**
 * Resolve clone/checkout branch:
 * 1. HTTP body baseBranch (e.g. Slack branch=)
 * 2. mergedInputs.branch when workflow YAML declares `branch`
 * 3. extractBranchHint(prompt) — applies even without YAML branch input
 */
export function resolveCheckoutBaseBranch(
  workflow: Workflow,
  mergedInputs: Record<string, string>,
  baseBranchFromBody?: string,
  promptForHint?: string,
  repoIdForHint?: string
): string | undefined {
  const fromBody =
    typeof baseBranchFromBody === "string" ? baseBranchFromBody.trim() : "";
  if (fromBody) return fromBody;

  if (workflowDeclaresBranchInput(workflow)) {
    const fromInput = (mergedInputs.branch ?? "").trim();
    if (fromInput) return fromInput;
  }

  const hint = extractBranchHint(promptForHint ?? "", repoIdForHint);
  return hint?.trim() || undefined;
}
