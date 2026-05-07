import assert from "node:assert";
import { describe, it } from "node:test";
import {
  extractJestSummary,
  findStepOutputWithJestSummary,
  formatJestStatusHeader,
  jestSummaryHasFailures,
} from "./jest-summary";

describe("extractJestSummary", () => {
  it("parses all-pass ubx-ui style summary", () => {
    const raw = `
Ran all test suites.

Test Suites: 61 passed, 5 skipped, 66 total
Tests:       438 passed, 52 skipped, 11 todo, 501 total
Snapshots:   0 total
Time:        33.908s
`;
    const j = extractJestSummary(raw);
    assert.strictEqual(j.matched, true);
    assert.strictEqual(j.failedSuites, 0);
    assert.strictEqual(j.passedSuites, 61);
    assert.strictEqual(j.skippedSuites, 5);
    assert.strictEqual(j.totalSuites, 66);
    assert.strictEqual(j.failedTests, 0);
    assert.strictEqual(j.passedTests, 438);
    assert.strictEqual(j.skippedTests, 52);
    assert.strictEqual(j.todoTests, 11);
    assert.strictEqual(j.totalTests, 501);
    assert.strictEqual(j.snapshotsTotal, 0);
    assert.strictEqual(j.time, "33.908s");
    assert.strictEqual(jestSummaryHasFailures(j), false);
  });

  it("parses failed suites and tests", () => {
    const raw = `
Test Suites: 2 failed, 60 passed, 62 total
Tests:       5 failed, 430 passed, 50 skipped, 485 total
Snapshots:   1 passed, 1 total
Time:        12s
`;
    const j = extractJestSummary(raw);
    assert.strictEqual(j.matched, true);
    assert.strictEqual(j.failedSuites, 2);
    assert.strictEqual(j.passedSuites, 60);
    assert.strictEqual(j.totalSuites, 62);
    assert.strictEqual(j.failedTests, 5);
    assert.strictEqual(j.passedTests, 430);
    assert.strictEqual(j.skippedTests, 50);
    assert.strictEqual(j.totalTests, 485);
    assert.strictEqual(j.snapshotsTotal, 1);
    assert.strictEqual(jestSummaryHasFailures(j), true);
  });

  it("handles tests-only line", () => {
    const raw = "Tests: 1 failed, 10 passed, 11 total\n";
    const j = extractJestSummary(raw);
    assert.strictEqual(j.matched, true);
    assert.strictEqual(j.failedTests, 1);
    assert.strictEqual(j.passedTests, 10);
    assert.strictEqual(j.totalTests, 11);
    assert.strictEqual(j.failedSuites, 0);
  });

  it("returns unmatched when no Jest summary lines", () => {
    const j = extractJestSummary("npm ERR! missing script\n");
    assert.strictEqual(j.matched, false);
    assert.strictEqual(jestSummaryHasFailures(j), false);
  });
});

describe("findStepOutputWithJestSummary", () => {
  it("returns first step output containing Jest markers", () => {
    const out = findStepOutputWithJestSummary([
      { output: "install ok\n" },
      { output: "Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total\n" },
      { output: "noise\n" },
    ]);
    assert.strictEqual(
      out,
      "Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total\n"
    );
  });

  it("returns null when no step matches", () => {
    assert.strictEqual(
      findStepOutputWithJestSummary([{ output: "hello" }]),
      null
    );
  });
});

describe("formatJestStatusHeader", () => {
  it("formats matched summary for successful run", () => {
    const j = extractJestSummary(`
Test Suites: 61 passed, 66 total
Tests:       438 passed, 501 total
Time:        1s
`);
    const h = formatJestStatusHeader("success", j);
    assert.ok(h.includes("*Zeverse run:* completed successfully"));
    assert.ok(h.includes("*Jest:*"));
    assert.ok(h.includes("61 passed"));
    assert.ok(h.includes("438 passed"));
  });

  it("notes missing Jest summary", () => {
    const h = formatJestStatusHeader("success", extractJestSummary(""));
    assert.ok(h.includes("summary not found"));
  });
});
