import assert from "node:assert";
import { describe, it } from "node:test";
import {
  extractBranchHint,
  resolveCheckoutBaseBranch,
  workflowDeclaresBranchInput,
} from "./branch-hint";
import type { Workflow } from "./workflows";

function wf(withBranch: boolean): Workflow {
  return {
    name: "test",
    description: "",
    inputs: withBranch
      ? [{ id: "branch", label: "Branch", required: false }]
      : [],
    steps: [],
    _filename: "test.yaml",
    _repoId: "repo",
  };
}

describe("extractBranchHint", () => {
  it("parses branch=name", () => {
    assert.strictEqual(extractBranchHint("run tests branch=feature/foo"), "feature/foo");
  });

  it("parses branch name word form", () => {
    assert.strictEqual(
      extractBranchHint("run tests branch AI-agents-rules-skills"),
      "AI-agents-rules-skills"
    );
  });

  it("parses on branch name", () => {
    assert.strictEqual(extractBranchHint("run tests on branch release-1"), "release-1");
  });

  it("parses on name branch", () => {
    assert.strictEqual(extractBranchHint("tests on my-feature branch"), "my-feature");
  });

  it("parses repo scoped run tests", () => {
    assert.strictEqual(
      extractBranchHint("ubx-ui AI-agents-rules-skills run tests", "ubx-ui"),
      "AI-agents-rules-skills"
    );
  });

  it("parses repo scoped test singular", () => {
    assert.strictEqual(extractBranchHint("ubx-ui feat-auth test", "ubx-ui"), "feat-auth");
  });

  it("does not apply repo scope without repoId", () => {
    assert.strictEqual(
      extractBranchHint("ubx-ui AI-agents-rules-skills run tests"),
      undefined
    );
  });

  it("returns undefined when absent", () => {
    assert.strictEqual(extractBranchHint("run tests on ubx-ui"), undefined);
  });
});

describe("resolveCheckoutBaseBranch", () => {
  it("prefers body baseBranch over inputs", () => {
    const r = resolveCheckoutBaseBranch(wf(true), { branch: "from-input" }, "from-body");
    assert.strictEqual(r, "from-body");
  });

  it("uses inputs.branch when workflow declares branch input", () => {
    const r = resolveCheckoutBaseBranch(wf(true), { branch: "feat-x" }, undefined);
    assert.strictEqual(r, "feat-x");
  });

  it("ignores inputs.branch when workflow has no branch input", () => {
    const r = resolveCheckoutBaseBranch(wf(false), { branch: "ignored" }, undefined);
    assert.strictEqual(r, undefined);
  });

  it("uses prompt hint without YAML branch input", () => {
    const r = resolveCheckoutBaseBranch(
      wf(false),
      {},
      undefined,
      "ubx-ui AI-agents-rules-skills run tests",
      "ubx-ui"
    );
    assert.strictEqual(r, "AI-agents-rules-skills");
  });

  it("prefers inputs.branch over prompt when YAML declares branch", () => {
    const r = resolveCheckoutBaseBranch(
      wf(true),
      { branch: "from-yaml" },
      undefined,
      "ubx-ui other-branch run tests",
      "ubx-ui"
    );
    assert.strictEqual(r, "from-yaml");
  });

  it("falls back to prompt when YAML declares branch but input empty", () => {
    const r = resolveCheckoutBaseBranch(
      wf(true),
      {},
      undefined,
      "branch=patch-1",
      "ubx-ui"
    );
    assert.strictEqual(r, "patch-1");
  });
});

describe("workflowDeclaresBranchInput", () => {
  it("detects branch input", () => {
    assert.strictEqual(workflowDeclaresBranchInput(wf(true)), true);
    assert.strictEqual(workflowDeclaresBranchInput(wf(false)), false);
  });
});
