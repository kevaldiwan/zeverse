import assert from "node:assert";
import { describe, it } from "node:test";
import {
  bulletsToNumberedLines,
  formatLLMTextForSlack,
  normalizeSlackMrkdwn,
  sanitizeForSlackMrkdwn,
  wrapWorkflowSummary,
} from "./format-slack-message";

describe("normalizeSlackMrkdwn", () => {
  it("collapses excessive newlines and trims trailing spaces", () => {
    assert.strictEqual(
      normalizeSlackMrkdwn("a  \n\n\n\n\nb"),
      "a\n\nb"
    );
  });

  it("trims outer whitespace", () => {
    assert.strictEqual(normalizeSlackMrkdwn("\n  hello  \n"), "hello");
  });
});

describe("bulletsToNumberedLines", () => {
  it("renumbers hyphen bullets at column 0", () => {
    const input = "- first\n- second\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. first\n2. second\n"
    );
  });

  it("skips fenced code blocks", () => {
    const input =
      "- outside\n```\n- keep as-is\n```\n- after\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. outside\n```\n- keep as-is\n```\n1. after\n"
    );
  });

  it("preserves indented nested lines", () => {
    const input = "- parent\n  - nested\n- next\n";
    const out = bulletsToNumberedLines(input);
    assert.ok(out.includes("1. parent"));
    assert.ok(out.includes("  - nested"));
    assert.ok(out.includes("2. next"));
  });

  it("resets numbering after blank line", () => {
    const input = "- one\n\n- two\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. one\n\n1. two\n"
    );
  });

  it("handles • bullets", () => {
    assert.strictEqual(
      bulletsToNumberedLines("• a\n• b"),
      "1. a\n2. b"
    );
  });
});

describe("sanitizeForSlackMrkdwn", () => {
  it("converts **bold** and __bold__ to Slack bold", () => {
    assert.strictEqual(sanitizeForSlackMrkdwn("**hi**"), "*hi*");
    assert.strictEqual(sanitizeForSlackMrkdwn("__there__"), "*there*");
  });

  it("converts ATX headings to bold lines", () => {
    assert.strictEqual(sanitizeForSlackMrkdwn("## Summary"), "*Summary*");
    assert.strictEqual(sanitizeForSlackMrkdwn("# Title "), "*Title*");
  });

  it("converts setext headings", () => {
    assert.strictEqual(
      sanitizeForSlackMrkdwn("Main Title\n========"),
      "*Main Title*"
    );
    assert.strictEqual(
      sanitizeForSlackMrkdwn("Subtitle\n---"),
      "*Subtitle*"
    );
  });

  it("converts markdown links and preserves Slack links", () => {
    assert.strictEqual(
      sanitizeForSlackMrkdwn("[Docs](https://example.com/a)"),
      "<https://example.com/a|Docs>"
    );
    assert.strictEqual(
      sanitizeForSlackMrkdwn("<https://example.com/b|already slack>"),
      "<https://example.com/b|already slack>"
    );
  });

  it("strips fenced code language tag only", () => {
    const input = "```typescript\nconst x = 1\n```";
    assert.strictEqual(
      sanitizeForSlackMrkdwn(input),
      "```\nconst x = 1\n```"
    );
  });

  it("does not alter inline code contents", () => {
    assert.strictEqual(
      sanitizeForSlackMrkdwn("use `**not bold**` here"),
      "use `**not bold**` here"
    );
  });

  it("converts strikethrough", () => {
    assert.strictEqual(sanitizeForSlackMrkdwn("~~gone~~"), "~gone~");
  });

  it("flattens task list markers", () => {
    assert.strictEqual(sanitizeForSlackMrkdwn("- [ ] todo"), "- todo");
    assert.strictEqual(sanitizeForSlackMrkdwn("- [x] done"), "- done");
  });

  it("flattens simple pipes tables", () => {
    const md =
      "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
    const out = sanitizeForSlackMrkdwn(md);
    assert.ok(out.includes("A: 1"));
    assert.ok(out.includes("B: 2"));
    assert.ok(out.includes("A: 3"));
  });

  it("escapes stray angle brackets outside slack links", () => {
    assert.strictEqual(
      sanitizeForSlackMrkdwn("x < y and a & b"),
      "x &lt; y and a &amp; b"
    );
  });
});

describe("formatLLMTextForSlack", () => {
  it("integration: realistic LLM blob", () => {
    const blob = [
      "## TL;DR",
      "",
      "**Action:** See [the guide](https://docs.example.com/start).",
      "",
      "- First **step**",
      "- Second step",
      "",
      "```ts",
      "export const n = 1",
      "```",
    ].join("\n");

    const out = formatLLMTextForSlack(blob);
    assert.ok(out.includes("*TL;DR*"));
    assert.ok(out.includes("*Action:*"));
    assert.ok(out.includes("<https://docs.example.com/start|the guide>"));
    assert.ok(out.includes("1. First *step*"));
    assert.ok(out.includes("2. Second step"));
    assert.ok(out.includes("```"));
    assert.ok(out.includes("export const n = 1"));
    assert.ok(!out.includes("**"));
  });
});

describe("wrapWorkflowSummary", () => {
  it("formats title body footer", () => {
    assert.strictEqual(
      wrapWorkflowSummary({
        title: "Done",
        body: "line1\nline2",
        footer: "<http://x|link>",
      }),
      "*Done*\n\nline1\nline2\n\n<http://x|link>"
    );
  });

  it("allows pre-bold title", () => {
    assert.strictEqual(
      wrapWorkflowSummary({
        title: "*Already*",
        body: "",
      }),
      "*Already*"
    );
  });
});
