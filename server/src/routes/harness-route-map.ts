/**
 * Pure helpers to map unified LLM JSON (intent + answer + suggestions)
 * onto harness route HTTP responses — testable without HTTP/LLM.
 */

export interface HarnessRouteSuggestion {
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
}

/** Response shape returned by mapUnifiedParsedToHarnessResponse. */
export interface HarnessMappedResponse {
  type: "proposal" | "answer" | "answer_with_proposal" | "clarify";
  repoId: string;
  workflow?: string;
  inputs?: Record<string, string>;
  suggestions?: HarnessRouteSuggestion[];
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  clarifyingQuestion?: string;
  missing?: string[];
  prdThreadMatch?: PrdThreadMatchPayload;
}

export interface PrdThreadMatchPayload {
  queryIndex: number | null;
  suggestion: string | null;
  /** When the user asks something off-thread instead of answering a Qi. */
  conversationalReply?: string;
  /** When match is unclear and there's no conversational reply. */
  noMatchExplanation?: string;
}

/** @internal exported for harness tests */
export type RouteIntentKind = "action" | "question" | "ambiguous";

export function inferIntent(parsed: Record<string, unknown>, hasSuggestions: boolean): RouteIntentKind {
  const raw = typeof parsed.intent === "string" ? parsed.intent.trim().toLowerCase() : "";
  if (raw === "action" || raw === "question" || raw === "ambiguous") return raw;

  const answerStr = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const cq =
    typeof parsed.clarifyingQuestion === "string"
      ? parsed.clarifyingQuestion.trim()
      : typeof parsed.question === "string"
        ? parsed.question.trim()
        : "";

  // Legacy harness route JSON: predictions without intent field
  if (hasSuggestions) return "action";
  if (answerStr) return "question";
  if (cq) return "ambiguous";
  return "ambiguous";
}

function proposalAlternativesFromNames(
  allNames: string[],
  excludeNames: string[],
  max = 100
): string[] {
  const ex = new Set(excludeNames);
  return allNames
    .filter((name) => name !== "harness" && !ex.has(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

/** @internal exported for harness tests */
export function mapUnifiedParsedToHarnessResponse(opts: {
  parsed: Record<string, unknown>;
  prompt: string;
  suggestionsBuilt: HarnessRouteSuggestion[];
  workflowNames: Set<string>;
  allWorkflowNames: string[];
  repoId: string;
  confidenceFallback: number;
  reasonFallback: string;
  wfNameParsed: string;
  /** When suggestions are empty after dry-run, return null -> caller runs server LLM */
  dryRunSuggestionsEmptyFallThrough?: boolean;
}): HarnessMappedResponse | null {
  const {
    parsed,
    prompt,
    suggestionsBuilt,
    workflowNames,
    allWorkflowNames,
    repoId,
    confidenceFallback,
    reasonFallback,
    wfNameParsed,
    dryRunSuggestionsEmptyFallThrough,
  } = opts;

  const hasSuggestions = suggestionsBuilt.length > 0;
  const intent = inferIntent(parsed, hasSuggestions);

  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const clarifyingQuestion =
    typeof parsed.clarifyingQuestion === "string"
      ? parsed.clarifyingQuestion.trim()
      : typeof parsed.question === "string"
        ? parsed.question.trim().replace(/^clarifying:\s*/i, "")
        : "";

  const alt = (exclude: string[]) =>
    proposalAlternativesFromNames(allWorkflowNames, exclude);

  switch (intent) {
    case "action": {
      if (hasSuggestions) {
        const primary = suggestionsBuilt[0];
        const selected = suggestionsBuilt.map((s) => s.workflow);
        return {
          type: "proposal",
          repoId,
          workflow: primary.workflow,
          inputs: primary.inputs,
          suggestions: suggestionsBuilt,
          alternatives: alt(selected),
          confidence: primary.confidence,
          reason: primary.reason,
        };
      }
      if (answer) {
        return {
          type: "answer",
          repoId,
          answer,
          confidence: confidenceFallback,
          reason: reasonFallback || "Action intent without workflow match",
        };
      }
      if (clarifyingQuestion) {
        return {
          type: "clarify",
          repoId,
          question: clarifyingQuestion,
          clarifyingQuestion,
          confidence: confidenceFallback,
          reason: reasonFallback || "Needs clarification",
        };
      }
      if (dryRunSuggestionsEmptyFallThrough) return null;
      return null;
    }
    case "question": {
      if (hasSuggestions && answer) {
        const primary = suggestionsBuilt[0];
        const selected = suggestionsBuilt.map((s) => s.workflow);
        return {
          type: "answer_with_proposal",
          repoId,
          workflow: primary.workflow,
          inputs: primary.inputs,
          suggestions: suggestionsBuilt,
          alternatives: alt(selected),
          confidence: primary.confidence,
          reason: primary.reason,
          answer,
        };
      }
      if (hasSuggestions && !answer) {
        const primary = suggestionsBuilt[0];
        const selected = suggestionsBuilt.map((s) => s.workflow);
        return {
          type: "proposal",
          repoId,
          workflow: primary.workflow,
          inputs: primary.inputs,
          suggestions: suggestionsBuilt,
          alternatives: alt(selected),
          confidence: primary.confidence,
          reason: primary.reason,
        };
      }
      if (answer) {
        return {
          type: "answer",
          repoId,
          answer,
          confidence: confidenceFallback,
          reason: reasonFallback || "Conversational answer",
        };
      }
      if (clarifyingQuestion) {
        return {
          type: "clarify",
          repoId,
          question: clarifyingQuestion,
          clarifyingQuestion,
          confidence: confidenceFallback,
          reason: reasonFallback || "Ambiguous prompt",
        };
      }
      if (dryRunSuggestionsEmptyFallThrough) return null;
      return buildUnknownWorkflowAnswer({
        wfNameParsed,
        workflowNames,
        repoId,
        confidenceFallback,
        reasonFallback,
        prompt,
        dryRunEmpty: false,
      });
    }
    case "ambiguous": {
      const q = clarifyingQuestion || answer;
      if (q) {
        return {
          type: "clarify",
          repoId,
          question: q,
          clarifyingQuestion: clarifyingQuestion || q,
          confidence: confidenceFallback,
          reason: reasonFallback || "Ambiguous intent",
        };
      }
      if (dryRunSuggestionsEmptyFallThrough) return null;
      return buildUnknownWorkflowAnswer({
        wfNameParsed,
        workflowNames,
        repoId,
        confidenceFallback,
        reasonFallback,
        prompt,
        dryRunEmpty: dryRunSuggestionsEmptyFallThrough,
      });
    }
  }
}

function buildUnknownWorkflowAnswer(opts: {
  wfNameParsed: string;
  workflowNames: Set<string>;
  repoId: string;
  confidenceFallback: number;
  reasonFallback: string;
  prompt: string;
  dryRunEmpty?: boolean;
}): HarnessMappedResponse | null {
  if (opts.dryRunEmpty) return null;
  const reason =
    opts.reasonFallback ||
    (!opts.workflowNames.has(opts.wfNameParsed)
      ? `LLM picked unknown workflow "${opts.wfNameParsed}"`
      : "Low confidence");
  return {
    type: "answer",
    repoId: opts.repoId,
    answer: [`You asked: _${opts.prompt}_`, "", `(${reason})`].join("\n"),
    confidence: opts.confidenceFallback,
    reason,
  };
}

/**
 * Map LLM JSON from the PRD Slack thread assistant (match user reply to open queries).
 */
export function mapPrdThreadParsedToHarnessResponse(opts: {
  parsed: Record<string, unknown>;
  repoId: string;
}): HarnessMappedResponse {
  const { parsed, repoId } = opts;

  const conversational =
    typeof parsed.conversationalReply === "string"
      ? parsed.conversationalReply.trim()
      : "";

  const suggestion =
    typeof parsed.suggestionForDoc === "string"
      ? parsed.suggestionForDoc.trim()
      : typeof parsed.suggestion === "string"
        ? parsed.suggestion.trim()
        : "";

  const rawIdx = parsed.matchIndex ?? parsed.queryIndex;
  let queryIndex: number | null =
    typeof rawIdx === "number" && Number.isFinite(rawIdx)
      ? Math.floor(rawIdx)
      : null;

  if (queryIndex !== null && queryIndex <= 0) queryIndex = null;

  const noMatchExplanation =
    typeof parsed.noMatchExplanation === "string"
      ? parsed.noMatchExplanation.trim()
      : "";

  if (conversational) {
    return {
      type: "answer",
      repoId,
      answer: conversational,
      confidence: 1,
      reason: "PRD thread: conversational reply",
      prdThreadMatch: {
        queryIndex: null,
        suggestion: null,
        conversationalReply: conversational,
        noMatchExplanation: noMatchExplanation || undefined,
      },
    };
  }

  if (queryIndex !== null && suggestion) {
    return {
      type: "answer",
      repoId,
      answer: "",
      confidence: 1,
      reason: `PRD thread: matched Q${queryIndex}`,
      prdThreadMatch: {
        queryIndex,
        suggestion,
      },
    };
  }

  return {
    type: "answer",
    repoId,
    answer: "",
    confidence: 0,
    reason: "PRD thread: no confident match",
    prdThreadMatch: {
      queryIndex: null,
      suggestion: null,
      noMatchExplanation:
        noMatchExplanation ||
        "I couldn't confidently map your reply to one of the open questions.",
    },
  };
}
