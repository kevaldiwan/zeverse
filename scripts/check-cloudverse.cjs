#!/usr/bin/env node
/**
 * Verifies CLOUDVERSE_* from repo-root .env: JWT expiry (if applicable) + POST /chat/completions.
 * Run from repo root: npm run check:cloudverse
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");

function loadEnvManual() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

loadEnvManual();

function jwtExpInfo(key) {
  const parts = String(key).trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(b64 + pad, "base64").toString("utf8")
    );
    if (typeof payload.exp !== "number") return null;
    const expMs = payload.exp * 1000;
    return {
      expIso: new Date(expMs).toISOString(),
      expired: Date.now() > expMs,
    };
  } catch {
    return null;
  }
}

async function main() {
  const base = (process.env.CLOUDVERSE_BASE_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.CLOUDVERSE_API_KEY || "").trim();
  if (!base || !key) {
    console.error("Missing CLOUDVERSE_BASE_URL or CLOUDVERSE_API_KEY in .env");
    process.exit(1);
  }

  const ji = jwtExpInfo(key);
  if (ji) {
    console.log(
      `JWT exp: ${ji.expIso} (UTC) — ${ji.expired ? "EXPIRED (renew key)" : "still valid"}`
    );
    if (ji.expired) {
      console.error(
        "\n401 Unauthorized is expected until you obtain a new CloudVerse API key.\n"
      );
    }
  } else {
    console.log("(Key is not a 3-part JWT — skipping local expiry check)\n");
  }

  const model = "anthropic-claude-4-5-haiku";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Say OK in one word." }],
      max_tokens: 16,
      temperature: 0,
    }),
  });

  const text = await res.text();
  console.log(`POST ${base}/chat/completions → HTTP ${res.status}`);
  console.log(text.length > 600 ? text.slice(0, 600) + "…" : text);
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
