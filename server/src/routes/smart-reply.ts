/**
 * Thin shim — delegates to /api/harness/route and reshapes the response
 * into the legacy SmartReplyResponse format so existing callers keep working.
 */
import { Router, Request, Response } from "express";

export const smartReplyRoutes = Router();

interface SmartReplyResponse {
  type: "answer" | "clarify" | "workflow";
  /** Present when harness returned answer_with_proposal — conversational text before running workflow. */
  answer?: string;
  question?: string;
  missing?: string[];
  workflow?: string;
  inputs?: Record<string, string>;
  repoId: string | null;
  confidence: number;
  reason: string;
}

smartReplyRoutes.post("/smart-reply", async (req: Request, res: Response) => {
  try {
    const { prompt, threadContext, repoId, surface } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    const harnessUrl = `http://localhost:${process.env.ZEVERSE_SERVER_PORT ?? "3100"}/api/harness/route`;
    const harnessRes = await fetch(harnessUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, repoId, threadContext, surface }),
    });
    const data = await harnessRes.json() as any;

    if (data.type === "proposal") {
      res.json({
        type: "workflow",
        workflow: data.workflow,
        inputs: data.inputs,
        repoId: data.repoId,
        confidence: data.confidence ?? 0,
        reason: data.reason ?? "",
      } satisfies SmartReplyResponse);
    } else if (data.type === "answer_with_proposal") {
      res.json({
        type: "workflow",
        workflow: data.workflow,
        inputs: data.inputs,
        answer: data.answer,
        repoId: data.repoId,
        confidence: data.confidence ?? 0,
        reason: data.reason ?? "",
      } satisfies SmartReplyResponse);
    } else if (data.type === "clarify") {
      res.json({
        type: "clarify",
        question: data.question,
        missing: data.missing,
        repoId: data.repoId,
        confidence: data.confidence ?? 0,
        reason: data.reason ?? "",
      } satisfies SmartReplyResponse);
    } else {
      res.json({
        type: "answer",
        answer: data.answer ?? "I don't have an answer for that right now.",
        repoId: data.repoId,
        confidence: data.confidence ?? 0,
        reason: data.reason ?? "",
      } satisfies SmartReplyResponse);
    }
  } catch (err: any) {
    res.status(500).json({
      type: "answer",
      answer: "Sorry, something went wrong on my end. Please try again.",
      repoId: null,
      confidence: 0,
      reason: `smart-reply error: ${err.message}`,
    });
  }
});
