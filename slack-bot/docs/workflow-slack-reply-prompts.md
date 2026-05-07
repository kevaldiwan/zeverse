# Repo workflows: Slack-friendly LLM output

Workflow YAML lives in each registered Git repository under `.zeverse/workflows/` (cached by Zeverse from the repo’s default branch). The Slack bot formats thread messages in code; prompts in those YAML files control **what the model writes**.

## PRD analysis (`--- SLACK REPLY ---`)

The PRD workflow should ask the model to wrap a Slack-facing summary between:

```text
--- SLACK REPLY ---
...content...
--- END SLACK REPLY ---
```

To match the bot’s numbering and tone pass (`format-slack-message` in the slack-bot package), align prompts with:

1. **Voice** — Write like a teammate: short paragraphs, plain language, no boilerplate like “As an AI…”
2. **Structure** — Use `1.` `2.` `3.` for sequential points instead of `-` or `•` bullets (the bot may also normalize simple top-level bullets).
3. **Emphasis** — Use Slack-style `*bold*` for small section labels (Slack mrkdwn).
4. **`## Summary` for Freshrelease-style analysis** — If the `fr-analyze` (or similar) step outputs a Markdown `## Summary` section, the Slack integration can prefer that slice for the thread.

## Epic / deliverable blocks

If the workflow uses `--- EPIC BREAKDOWN ---` / `--- END EPIC BREAKDOWN ---`, use the same numbering and bolding conventions inside that block.

Changes to prompts require committing to the **target repo** and letting Zeverse refresh its workflow cache (TTL, or operator refresh).

## PRD queries JSON (`queries` fenced block)

The `post-queries` step consumes the fenced `queries` JSON array from the analyse step. For each item, **`anchor` must be a verbatim excerpt from the PRD** (copy-paste a heading or full sentence exactly as it appears). The runner checks that substring against the fetched doc text and sends it to Google Drive as `quotedFileContent` so threads anchor to the right passage instead of floating as generic document comments.

If the anchor is missing or cannot be matched to the doc text, **`post-queries` skips that row** for Google Docs (nothing posted)—so authors must supply a valid verbatim excerpt every time they expect a doc comment.

**Clarifications only:** Questions must be **open clarifications**—ambiguity, gaps, inconsistencies, feasibility vs the codebase—not grammar, spelling, typos, tone, or stylistic/copy edits. Repeat that constraint in repo YAML prompts if needed. For workflow name `prd-analysis`, the Zeverse server also augments the LLM **system** message so every `llm` / `review` step in that workflow receives these rules centrally (alongside whatever your step prompts say).

**Suggest-edits (`gdoc-suggest`):** Comments posted from the `suggestions` JSON use **Proposed text:** plus the replacement; Google Docs shows the passage to change via the comment anchor—there is no separate “Original:” block in the comment body.

## Test workflow (`test`)

For workflows named `test` that run Jest then an LLM **summarise** step, align the prompt with Slack mrkdwn and predictable structure:

1. Wrap the user-facing summary between `--- TEST SUMMARY ---` and `--- END TEST SUMMARY ---` so humans (and future tooling) can find it reliably.

2. **Workflow vs tests** — The Zeverse run can finish successfully while Jest reports failures (when the Jest step uses `continueOnError`). Call out explicitly: workflow completed vs tests passed/failed with counts.

3. **Metrics** — Prefer a short fenced code block for totals (suites, tests, time) instead of GitHub-flavored Markdown tables.

4. **Each failing test** — Include why it failed, a single **classification** (`production code bug`, `logic/behavior mismatch`, `test wrong or outdated`, `config/tooling/environment`, or `flaky`), and what to change next.

The Slack bot prepends a machine-parsed Jest summary when possible and can show a **Fix failing tests** button when failures are detected.

**Branch:** If the workflow YAML declares an optional `branch` input, Zeverse resolves the git checkout from `POST /api/harness/execute` `baseBranch` (Slack: `branch=<name>` in the message) or from `inputs.branch` (keyword routing can fill this from phrases like `branch=…` or `on branch …`). If both are empty, the repo’s registered **default branch** is used.

Changes require committing to the **target repo** (under `.zeverse/workflows/`) and refreshing the hub workflow cache.
