/**
 * Unit tests for harness route intent mapping (no HTTP / LLM).
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/harness-route-map.test.ts
 */

import assert from "node:assert/strict";
import {
  inferIntent,
  mapUnifiedParsedToHarnessResponse,
  mapPrdThreadParsedToHarnessResponse,
  type HarnessRouteSuggestion,
} from "../harness-route-map";

function run(test: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${test}`);
  } catch (err: any) {
    console.error(`  ✗ ${test}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

const WORKFLOW_NAMES = new Set(["fix-bug", "explain-codebase", "dev"]);
const ALL_NAMES = ["harness", "fix-bug", "explain-codebase", "dev"];

const sugFixBug: HarnessRouteSuggestion = {
  workflow: "fix-bug",
  inputs: { requirement: "hit rate is low", path: "/auth" },
  confidence: 0.85,
  reason: "Bug symptom",
};

console.log("harness-route-map tests\n");

run("inferIntent: explicit ambiguous", () => {
  assert.equal(inferIntent({ intent: "ambiguous", clarifyingQuestion: "Which env?" }, false), "ambiguous");
});

run("inferIntent: infer question from answer when no suggestions", () => {
  assert.equal(inferIntent({ answer: "Here is help." }, false), "question");
});

run("inferIntent: infer action when suggestions exist without intent field", () => {
  assert.equal(inferIntent({ suggestions: [{}] }, true), "action");
});

run("map: question intent + suggestion + answer -> answer_with_proposal", () => {
  const mapped = mapUnifiedParsedToHarnessResponse({
    parsed: {
      intent: "question",
      answer: "The hit rate KPI usually means acceptance over opportunities.",
      suggestions: [
        {
          workflow: "fix-bug",
          inputs: { path: "/auth" },
          confidence: 0.85,
          reason: "Might need a bugfix",
        },
      ],
    },
    prompt: "What does hit rate mean?",
    suggestionsBuilt: [sugFixBug],
    workflowNames: WORKFLOW_NAMES,
    allWorkflowNames: ALL_NAMES,
    repoId: "demo",
    confidenceFallback: 0.85,
    reasonFallback: "test",
    wfNameParsed: "fix-bug",
  });
  assert.equal(mapped?.type, "answer_with_proposal");
  assert.ok(mapped?.answer?.includes("hit rate"));
  assert.equal(mapped?.workflow, "fix-bug");
});

run("map: action intent + suggestions -> proposal", () => {
  const mapped = mapUnifiedParsedToHarnessResponse({
    parsed: {
      intent: "action",
    },
    prompt: "fix login",
    suggestionsBuilt: [sugFixBug],
    workflowNames: WORKFLOW_NAMES,
    allWorkflowNames: ALL_NAMES,
    repoId: "demo",
    confidenceFallback: 0.85,
    reasonFallback: "Bug",
    wfNameParsed: "fix-bug",
  });
  assert.equal(mapped?.type, "proposal");
});

run("map: question intent, only answer -> answer", () => {
  const mapped = mapUnifiedParsedToHarnessResponse({
    parsed: {
      intent: "question",
      answer: "Use npm run test locally.",
      suggestions: [],
    },
    prompt: "How do I test?",
    suggestionsBuilt: [],
    workflowNames: WORKFLOW_NAMES,
    allWorkflowNames: ALL_NAMES,
    repoId: "demo",
    confidenceFallback: 0,
    reasonFallback: "n/a",
    wfNameParsed: "ask",
  });
  assert.equal(mapped?.type, "answer");
  assert.ok(mapped?.answer?.includes("npm"));
});

run("map: ambiguous + clarifyingQuestion -> clarify", () => {
  const mapped = mapUnifiedParsedToHarnessResponse({
    parsed: {
      intent: "ambiguous",
      clarifyingQuestion: 'When you said "broken", did you mean QA or prod?',
      suggestions: [],
    },
    prompt: "It's broken",
    suggestionsBuilt: [],
    workflowNames: WORKFLOW_NAMES,
    allWorkflowNames: ALL_NAMES,
    repoId: "demo",
    confidenceFallback: 0,
    reasonFallback: "n/a",
    wfNameParsed: "ask",
  });
  assert.equal(mapped?.type, "clarify");
  assert.ok(mapped?.question?.includes("broken"));
});

run("fallback answer echoes user prompt (no canned “rephrase” copy)", () => {
  const mapped = mapUnifiedParsedToHarnessResponse({
    parsed: { intent: "question", suggestions: [] },
    prompt: "mystery text",
    suggestionsBuilt: [],
    workflowNames: WORKFLOW_NAMES,
    allWorkflowNames: ALL_NAMES,
    repoId: "demo",
    confidenceFallback: 0.3,
    reasonFallback: "Low confidence",
    wfNameParsed: "deploy-prod",
  });
  assert.equal(mapped?.type, "answer");
  const a = mapped?.answer ?? "";
  assert.ok(a.includes("mystery text"));
  assert.ok(!a.toLowerCase().includes("could you rephrase"));
  assert.ok(!a.includes("Could you be more specific"));
});

run("prd thread: conversational wins over matchIndex", () => {
  const mapped = mapPrdThreadParsedToHarnessResponse({
    parsed: {
      matchIndex: 1,
      suggestionForDoc: "yes",
      conversationalReply: "Actually can we reschedule the rollout?",
      noMatchExplanation: "",
    },
    repoId: "demo",
  });
  assert.equal(mapped.answer, "Actually can we reschedule the rollout?");
  assert.equal(mapped.prdThreadMatch?.queryIndex, null);
});

run("prd thread: doc match", () => {
  const mapped = mapPrdThreadParsedToHarnessResponse({
    parsed: {
      matchIndex: 2,
      suggestionForDoc: "We'll add audit logging.",
    },
    repoId: "demo",
  });
  assert.equal(mapped.prdThreadMatch?.queryIndex, 2);
  assert.equal(mapped.prdThreadMatch?.suggestion, "We'll add audit logging.");
});

console.log("\nAll harness-route-map tests passed.");
