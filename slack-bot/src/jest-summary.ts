/**
 * Parse Jest CLI summary lines from shell step output (--colors=false).
 */

export interface JestSummaryParsed {
  /** True when `Test Suites:` and/or `Tests:` summary lines were found. */
  matched: boolean;
  failedSuites: number;
  passedSuites: number;
  skippedSuites: number;
  totalSuites: number;
  failedTests: number;
  passedTests: number;
  skippedTests: number;
  todoTests: number;
  pendingTests: number;
  totalTests: number;
  snapshotsTotal?: number;
  /** Raw remainder of the Time: line (e.g. "33.908s"). */
  time?: string;
}

const EMPTY: Omit<JestSummaryParsed, "matched"> = {
  failedSuites: 0,
  passedSuites: 0,
  skippedSuites: 0,
  totalSuites: 0,
  failedTests: 0,
  passedTests: 0,
  skippedTests: 0,
  todoTests: 0,
  pendingTests: 0,
  totalTests: 0,
};

function parseAggregateFragment(fragment: string): {
  failed: number;
  passed: number;
  skipped: number;
  todo: number;
  pending: number;
  total: number;
} {
  const out = {
    failed: 0,
    passed: 0,
    skipped: 0,
    todo: 0,
    pending: 0,
    total: 0,
  };
  const pairRe = /(\d+)\s+(failed|passed|skipped|todo|pending)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(fragment))) {
    const n = Number(m[1]);
    const k = m[2].toLowerCase();
    if (k === "failed") out.failed += n;
    else if (k === "passed") out.passed += n;
    else if (k === "skipped") out.skipped += n;
    else if (k === "todo") out.todo += n;
    else if (k === "pending") out.pending += n;
  }
  const totalM = fragment.match(/(\d+)\s+total\b/i);
  if (totalM) out.total = Number(totalM[1]);
  return out;
}

function parseSnapshots(fragment: string): number | undefined {
  const totalM = fragment.match(/(\d+)\s+total\b/i);
  if (totalM) return Number(totalM[1]);
  const n = fragment.match(/^\s*(\d+)\s*$/);
  if (n) return Number(n[1]);
  return undefined;
}

/** Extract suite/test totals from raw Jest log text. */
export function extractJestSummary(text: string): JestSummaryParsed {
  const suiteM = text.match(/^\s*Test Suites:\s*(.+)$/m);
  const testsM = text.match(/^\s*Tests:\s*(.+)$/m);
  const snapM = text.match(/^\s*Snapshots:\s*(.+)$/m);
  const timeM = text.match(/^\s*Time:\s*(.+)$/m);

  if (!suiteM && !testsM) {
    return { matched: false, ...EMPTY };
  }

  let failedSuites = 0;
  let passedSuites = 0;
  let skippedSuites = 0;
  let totalSuites = 0;
  if (suiteM) {
    const s = parseAggregateFragment(suiteM[1]);
    failedSuites = s.failed;
    passedSuites = s.passed;
    skippedSuites = s.skipped;
    totalSuites = s.total;
  }

  let failedTests = 0;
  let passedTests = 0;
  let skippedTests = 0;
  let todoTests = 0;
  let pendingTests = 0;
  let totalTests = 0;
  if (testsM) {
    const t = parseAggregateFragment(testsM[1]);
    failedTests = t.failed;
    passedTests = t.passed;
    skippedTests = t.skipped;
    todoTests = t.todo;
    pendingTests = t.pending;
    totalTests = t.total;
  }

  let snapshotsTotal: number | undefined;
  if (snapM) {
    snapshotsTotal = parseSnapshots(snapM[1]);
  }

  const time = timeM ? timeM[1].trim() : undefined;

  return {
    matched: true,
    failedSuites,
    passedSuites,
    skippedSuites,
    totalSuites,
    failedTests,
    passedTests,
    skippedTests,
    todoTests,
    pendingTests,
    totalTests,
    snapshotsTotal,
    time,
  };
}

export function jestSummaryHasFailures(p: JestSummaryParsed): boolean {
  return p.failedTests > 0 || p.failedSuites > 0;
}

/** First step output that contains Jest summary markers (any step id). */
export function findStepOutputWithJestSummary(
  steps: { output: string }[]
): string | null {
  for (const s of steps) {
    const t = s.output ?? "";
    if (!t.trim()) continue;
    const j = extractJestSummary(t);
    if (j.matched) return t;
  }
  return null;
}

/** Short mrkdwn lines for Slack (prepend under workflow title). */
export function formatJestStatusHeader(
  zeverseRunStatus: string,
  jest: JestSummaryParsed
): string {
  const runLabel =
    zeverseRunStatus === "success"
      ? "completed successfully"
      : zeverseRunStatus === "failed"
        ? "failed"
        : zeverseRunStatus;

  const lines = [`*Zeverse run:* ${runLabel}`];

  if (!jest.matched) {
    lines.push("*Jest:* summary not found in step output — see details below.");
    return lines.join("\n");
  }

  const suiteParts: string[] = [];
  if (jest.failedSuites > 0) suiteParts.push(`${jest.failedSuites} failed`);
  if (jest.passedSuites > 0) suiteParts.push(`${jest.passedSuites} passed`);
  if (jest.skippedSuites > 0) suiteParts.push(`${jest.skippedSuites} skipped`);
  const suiteStr =
    suiteParts.length > 0
      ? `Suites: ${suiteParts.join(", ")}${jest.totalSuites > 0 ? ` (${jest.totalSuites} total)` : ""}`
      : jest.totalSuites > 0
        ? `Suites: ${jest.totalSuites} total`
        : "";

  const testParts: string[] = [];
  if (jest.failedTests > 0) testParts.push(`${jest.failedTests} failed`);
  if (jest.passedTests > 0) testParts.push(`${jest.passedTests} passed`);
  if (jest.skippedTests > 0) testParts.push(`${jest.skippedTests} skipped`);
  if (jest.todoTests > 0) testParts.push(`${jest.todoTests} todo`);
  if (jest.pendingTests > 0) testParts.push(`${jest.pendingTests} pending`);
  const testStr =
    testParts.length > 0
      ? `Tests: ${testParts.join(", ")}${jest.totalTests > 0 ? ` (${jest.totalTests} total)` : ""}`
      : jest.totalTests > 0
        ? `Tests: ${jest.totalTests} total`
        : "";

  const bits = [suiteStr, testStr].filter(Boolean);
  if (jest.snapshotsTotal !== undefined) {
    bits.push(`Snapshots: ${jest.snapshotsTotal} total`);
  }
  if (jest.time) bits.push(`Time: ${jest.time}`);

  lines.push(`*Jest:* ${bits.join(" · ")}`);
  return lines.join("\n");
}
