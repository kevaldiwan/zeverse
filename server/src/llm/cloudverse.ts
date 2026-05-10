import OpenAI from "openai";
import type { ZeverseConfig } from "../config";
import type { LLMMessage, LLMProvider, LLMResponse } from "./types";

/** If the key is a JWT, return a hint when `exp` is in the past */
export function cloudVerseJwtExpiredHint(apiKey: string): string | undefined {
  const key = apiKey.trim();
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);

    const payload = JSON.parse(
      Buffer.from(b64 + pad, "base64").toString("utf8")
    ) as { exp?: number };

    if (typeof payload.exp !== "number") return undefined;

    const expMs = payload.exp * 1000;

    if (Date.now() <= expMs) return undefined;

    return `API key JWT expired at ${new Date(expMs).toISOString()} — obtain a new CloudVerse key.`;
  } catch {
    return undefined;
  }
}

function normalizeBaseURL(raw?: string): string {
  if (!raw) throw new Error("Missing CLOUDVERSE_BASE_URL");

  let url = raw.trim();

  // enforce protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  try {
    return new URL(url).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid CLOUDVERSE_BASE_URL: ${raw}`);
  }
}

export class CloudVerseProvider implements LLMProvider {
  private client: OpenAI;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private baseURL: string;

  constructor(config: ZeverseConfig) {
    const baseURL = normalizeBaseURL(
      config.llm.base_url || process.env.CLOUDVERSE_BASE_URL
    );

    const apiKey = (config.llm.api_key || process.env.CLOUDVERSE_API_KEY || "").trim();

    if (!apiKey) {
      throw new Error("Missing CLOUDVERSE_API_KEY environment variable");
    }

    const expiredHint = cloudVerseJwtExpiredHint(apiKey);
    if (expiredHint) {
      console.warn(`[CloudVerse] ${expiredHint}`);
    }

    this.apiKey = apiKey;
    this.baseURL = baseURL;

    console.log("[CloudVerse INIT]", {
      baseURL: this.baseURL,
      model: config.llm.model,
      hasKey: !!this.apiKey,
    });

    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.apiKey,
    });

    this.model = config.llm.model;
    this.maxTokens = config.llm.max_tokens;
    this.temperature = config.llm.temperature;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      });

      if (!response?.choices?.length) {
        throw new Error(
          `Invalid CloudVerse response (no choices). Model=${this.model}`
        );
      }

      const choice = response.choices[0];

      const content =
        choice?.message?.content ??
        choice?.delta?.content ??
        (typeof choice?.text === "string" ? choice.text : "") ??
        "";

      if (!content) {
        throw new Error(
          `Empty response from CloudVerse. finish_reason=${choice?.finish_reason}`
        );
      }

      return {
        content,
        model: response.model ?? this.model,
        usage: response.usage
          ? {
              prompt_tokens: response.usage.prompt_tokens,
              completion_tokens: response.usage.completion_tokens,
              total_tokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (err: any) {
      console.error("[CloudVerse ERROR]", {
        message: err?.message,
        baseURL: this.baseURL,
        model: this.model,
      });

      const detail =
        err?.response?.data ||
        err?.error ||
        err?.message ||
        String(err);

      throw new Error(
        `CloudVerse request failed (model=${this.model}): ${JSON.stringify(detail)}`
      );
    }
  }
}
