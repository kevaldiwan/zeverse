import OpenAI from "openai";
import type { ZeverseConfig } from "../config";
import type { LLMMessage, LLMProvider, LLMResponse } from "./types";

/** If the key is a JWT, return a hint when `exp` is in the past */
export function cloudVerseJwtExpiredHint(apiKey: string): string | undefined {
  const key = apiKey?.trim();
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

    return `API key JWT expired at ${new Date(expMs).toISOString()}`;
  } catch {
    return undefined;
  }
}

function normalizeBaseURL(raw?: string): string {
  if (!raw) throw new Error("Missing CLOUDVERSE_BASE_URL");

  let url = raw.trim();

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
    const rawBase =
      config.llm.base_url || process.env.CLOUDVERSE_BASE_URL;

    const apiKey =
      config.llm.api_key || process.env.CLOUDVERSE_API_KEY || "";

    if (!rawBase) {
      throw new Error("CLOUDVERSE_BASE_URL is required");
    }

    if (!apiKey) {
      throw new Error("CLOUDVERSE_API_KEY is required");
    }

    this.baseURL = normalizeBaseURL(rawBase);
    this.apiKey = apiKey.trim();

    const expiredHint = cloudVerseJwtExpiredHint(this.apiKey);
    if (expiredHint) {
      console.warn(`[CloudVerse] ${expiredHint}`);
    }

    console.log("[CloudVerse INIT]", {
      baseURL: this.baseURL,
      model: config.llm.model,
      hasKey: !!this.apiKey,
    });

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    } as any);

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
        throw new Error("No choices returned from CloudVerse");
      }

      const choice = response.choices[0];

      // ✅ FIXED: NO delta (only message.content exists in non-streaming)
      const content =
        typeof choice?.message?.content === "string"
          ? choice.message.content
          : "";

      if (!content) {
        throw new Error(
          `Empty response from CloudVerse (finish_reason=${choice?.finish_reason})`
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
    } catch (err: unknown) {
      const error = err as any;

      console.error("[CloudVerse ERROR]", {
        message: error?.message,
        baseURL: this.baseURL,
        model: this.model,
      });

      const detail =
        error?.response?.data ||
        error?.error ||
        error?.message ||
        String(err);

      throw new Error(
        `CloudVerse request failed (model=${this.model}): ${JSON.stringify(detail)}`
      );
    }
  }
}
