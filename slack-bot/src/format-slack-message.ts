/**
 * Normalize and optionally convert list bullets to numbered lines for Slack mrkdwn.
 * Repo-side workflow prompts (`.zeverse/workflows/*.yaml`) still control LLM tone;
 * these helpers unify spacing and list style in posted messages.
 */

export function normalizeSlackMrkdwn(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line.replace(/\s+$/u, ""));
  }
  let s = out.join("\n");
  // Collapse 3+ consecutive newlines to double newlines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Turns top-level markdown/OEM bullet lines into numbered lines. Skips content
 * inside fenced ``` code blocks and lines that begin with whitespace (nested items).
 */
export function bulletsToNumberedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let n = 0;

  const isBulletLine = (trimmed: string): boolean =>
    /^[-*]\s+/.test(trimmed) ||
    /^•\s+/.test(trimmed) ||
    /^[•∙]\s*/u.test(trimmed);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^```/)) {
      inFence = !inFence;
      n = 0;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed === "") {
      n = 0;
      out.push(line);
      continue;
    }

    const isIndented = /^\s/.test(line);

    if (!isIndented && isBulletLine(trimmed)) {
      n += 1;
      const body = trimmed.replace(/^[-*]\s+/, "").replace(/^[•∙]\s+/u, "");
      out.push(`${n}. ${body}`);
    } else {
      if (!isIndented) n = 0;
      out.push(line);
    }
  }

  return out.join("\n");
}

/**
 * Strip optional language tag from the opening line of a fenced code block body
 * (content between ``` markers, excluding the markers themselves).
 */
function stripFenceOpeningLang(inner: string): string {
  const trimmedLead = inner.replace(/^\n+/, "");
  const nl = trimmedLead.indexOf("\n");
  if (nl === -1) {
    const t = trimmedLead.trim();
    if (t === "") return inner;
    return /^[\w.#+-]+$/.test(t) ? "" : inner;
  }
  const firstLine = trimmedLead.slice(0, nl).trim();
  const rest = trimmedLead.slice(nl + 1);
  if (/^[\w.#+-]+$/.test(firstLine)) {
    return rest;
  }
  return inner;
}

/** Slack mrkdwn link: <url|label> or <url> */
const SLACK_LINK_RE = /<[^>\s]+(?:\|[^>]+)?>/g;

function escapeHtmlOutsideSlackLinks(s: string): string {
  const parts: string[] = [];
  let last = 0;
  SLACK_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLACK_LINK_RE.exec(s)) !== null) {
    parts.push(escapeHtmlAmpLtGt(s.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(escapeHtmlAmpLtGt(s.slice(last)));
  return parts.join("");
}

function escapeHtmlAmpLtGt(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert GitHub-flavored markdown-ish tables to plain key: value lines (best-effort).
 */
function flattenMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const MAX_TABLE_ROWS = 40;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
      out.push(line);
      i++;
      continue;
    }
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) {
      out.push(line);
      i++;
      continue;
    }
    const next = lines[i + 1]?.trim() ?? "";
    if (!/^\|?\s*:?[\s\-:|]+\|?$/.test(next)) {
      out.push(line);
      i++;
      continue;
    }
    const headerCells = cells;
    const tableStart = i;
    i += 2;
    let rows = 0;
    while (i < lines.length && rows < MAX_TABLE_ROWS) {
      const rowTrim = lines[i].trim();
      if (!rowTrim.includes("|")) break;
      const rowCells = rowTrim
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      if (rowCells.every((c) => c === "")) break;
      const pairs: string[] = [];
      const n = Math.min(headerCells.length, rowCells.length);
      for (let k = 0; k < n; k++) {
        const h = headerCells[k] || `col${k + 1}`;
        pairs.push(`${h}: ${rowCells[k]}`);
      }
      out.push(pairs.join(" · "));
      i++;
      rows++;
    }
    if (rows === 0) {
      out.push(lines[tableStart]);
      out.push(lines[tableStart + 1]);
      i = tableStart + 2;
    }
  }

  return out.join("\n");
}

/** Markdown [label](url) -> Slack <url|label>; bare URLs optional */
function convertMarkdownLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_full, label: string, url: string) => {
    const u = String(url).trim();
    const l = String(label).trim();
    if (!u || !/^https?:\/\//i.test(u)) return _full;
    return `<${u}|${l.replace(/\|/g, "｜")}>`;
  });
}

/** ATX heading line -> *Heading* */
function convertAtxHeadingLine(line: string): string {
  const m = line.match(/^(\s{0,3})(#{1,6})\s+(.+?)\s*$/);
  if (!m) return line;
  const body = m[3].replace(/\s+#+\s*$/u, "").trim();
  return `${m[1]}*${body}*`;
}

function flattenTaskListLine(line: string): string {
  const m = line.match(/^(\s*)([-*])\s+\[(?: |x|X)\]\s+(.*)$/);
  if (!m) return line;
  return `${m[1]}${m[2]} ${m[3]}`;
}

/** Setext: previous non-empty line becomes heading when followed by === or --- */
function convertSetextHeadings(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (next !== undefined && /^=+\s*$/.test(next.trim()) && line.trim() !== "") {
      out.push(`*${line.trim()}*`);
      i++;
      continue;
    }
    if (next !== undefined && /^-+\s*$/.test(next.trim()) && line.trim() !== "" && line.trim().startsWith("#") === false) {
      out.push(`*${line.trim()}*`);
      i++;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * **bold** / __bold__ -> *bold* (non-greedy, avoids crossing newlines)
 */
function convertBoldUnderscore(s: string): string {
  let t = s.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  t = t.replace(/__([^_\n]+)__/g, "*$1*");
  return t;
}

function convertStrike(s: string): string {
  return s.replace(/~~([^~\n]+)~~/g, "~$1~");
}

/** Protect inline `code` spans — returns segments */
function splitByInlineCode(s: string): { text: string; isCode: boolean }[] {
  const segments: { text: string; isCode: boolean }[] = [];
  let pos = 0;
  while (pos < s.length) {
    const idx = s.indexOf("`", pos);
    if (idx === -1) {
      segments.push({ text: s.slice(pos), isCode: false });
      break;
    }
    segments.push({ text: s.slice(pos, idx), isCode: false });
    let end = idx + 1;
    while (end < s.length && s[end] === "`") end++;
    const tickCount = end - idx;
    if (tickCount >= 3) {
      segments.push({ text: s.slice(idx, end), isCode: false });
      pos = end;
      continue;
    }
    const close = s.indexOf("`", end);
    if (close === -1) {
      segments.push({ text: s.slice(idx), isCode: false });
      break;
    }
    segments.push({ text: s.slice(idx, close + 1), isCode: true });
    pos = close + 1;
  }
  return segments;
}

function transformPlainSegment(seg: string): string {
  let s = seg;
  s = convertMarkdownLinks(s);
  s = convertBoldUnderscore(s);
  s = convertStrike(s);
  return s;
}

function sanitizeLinePreservingInlineCode(line: string): string {
  const parts = splitByInlineCode(line);
  return parts.map((p) => (p.isCode ? p.text : transformPlainSegment(p.text))).join("");
}

/**
 * Process text outside of ``` fenced blocks: headings, tables, task lists, md links, bold, strike, HTML escape.
 */
function sanitizeOutsideFences(text: string): string {
  let s = flattenMarkdownTables(text);
  s = convertSetextHeadings(s);
  const lines = s.split("\n");
  const outLines = lines.map((line) => {
    let L = convertAtxHeadingLine(line);
    L = flattenTaskListLine(L);
    L = sanitizeLinePreservingInlineCode(L);
    return L;
  });
  s = outLines.join("\n");
  return escapeHtmlOutsideSlackLinks(s);
}

/**
 * Convert LLM / GitHub-flavored markdown to Slack mrkdwn where possible.
 * Preserves fenced ``` blocks (strips opening language tag only) and inline `code` verbatim.
 */
export function sanitizeForSlackMrkdwn(text: string): string {
  if (!text) return "";
  let result = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("```", i);
    if (open === -1) {
      result += sanitizeOutsideFences(text.slice(i));
      break;
    }
    result += sanitizeOutsideFences(text.slice(i, open));
    const afterTicks = open + 3;
    const close = text.indexOf("```", afterTicks);
    if (close === -1) {
      result += text.slice(open);
      break;
    }
    let inner = text.slice(afterTicks, close);
    inner = stripFenceOpeningLang(inner);
    result += "```";
    if (inner.length > 0 && !inner.startsWith("\n")) result += "\n";
    result += inner;
    result += "```";
    i = close + 3;
  }
  return result;
}

/**
 * Full pipeline for LLM-produced bodies: sanitize markdown → numbered lists → whitespace normalize.
 */
export function formatLLMTextForSlack(text: string): string {
  return normalizeSlackMrkdwn(bulletsToNumberedLines(sanitizeForSlackMrkdwn(text)));
}

/**
 * Ensures a bold title, optional body, and optional trailing link line with consistent spacing.
 */
export function wrapWorkflowSummary(parts: {
  title: string;
  body: string;
  footer?: string;
}): string {
  const title = parts.title.startsWith("*") ? parts.title : `*${parts.title}*`;
  const chunks: string[] = [title];
  const body = parts.body.trim();
  if (body) chunks.push("", body);
  const footer = (parts.footer ?? "").trim();
  if (footer) {
    chunks.push("", footer);
  }
  return chunks.join("\n");
}
