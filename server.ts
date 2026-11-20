import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

const GEMINI_MODELS = [
  { id: "gemini-4-hydrogen", name: "Gemini 4 Flash" },
  { id: "gemini-3.1-flash-lite", name: "Gemini Flash Lite" },
];
const ALLOWED_MODELS = new Set(GEMINI_MODELS.map((m) => m.id));
const DEFAULT_MODEL = GEMINI_MODELS[0].id;
const MAX_CHARS = 1_500_000;

interface AskMessage {
  role: "user" | "assistant";
  content: string;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error("Gemini isn't configured yet. Check your API key in Settings > Secrets."),
      { status: 503, code: "missing_key" },
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function formatGeminiError(err: unknown): { message: string; code: string } {
  const e = err as { status?: number; code?: string | number; message?: string };
  const raw = String(e?.message ?? "");
  const status = typeof e?.status === "number" ? e.status : typeof e?.code === "number" ? e.code : 0;

  if (e?.code === "missing_key") {
    return { message: raw, code: "missing_key" };
  }
  if (status === 403 || status === 400 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)) {
    return {
      message: "Gemini couldn't authenticate the request. Check your API key in Settings > Secrets.",
      code: "auth_error",
    };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw)) {
    return {
      message: "Gemini rate or quota limit reached. Try again in a moment, or check your API key in Settings > Secrets.",
      code: "usage_limit",
    };
  }
  if (status === 404 || /NOT_FOUND/i.test(raw)) {
    return {
      message: "The selected Gemini model isn't available. Try switching to Gemini 4 Flash.",
      code: "model_not_found",
    };
  }
  return {
    message: raw ? `Gemini couldn't answer: ${raw.split("\n")[0]}` : "Gemini couldn't answer. Please try again.",
    code: "gemini_error",
  };
}

function validAskBody(body: unknown): body is { model?: string; instructions?: string; messages: AskMessage[] } {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length >= 200) return false;
  if (b.instructions !== undefined && typeof b.instructions !== "string") return false;
  if (b.model !== undefined && (typeof b.model !== "string" || b.model.length >= 100)) return false;
  let totalChars = typeof b.instructions === "string" ? b.instructions.length : 0;
  for (const m of b.messages) {
    if (!m || typeof m !== "object") return false;
    const msg = m as Record<string, unknown>;
    if ((msg.role !== "user" && msg.role !== "assistant") || typeof msg.content !== "string") return false;
    totalChars += msg.content.length;
    if (totalChars >= MAX_CHARS) return false;
  }
  return true;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/api/ai/gemini/status", (_req: Request, res: Response) => {
    res.json({
      available: Boolean(process.env.GEMINI_API_KEY?.trim()),
      models: GEMINI_MODELS,
    });
  });

  app.post("/api/ai/gemini/ask", async (req: Request, res: Response) => {
    if (!validAskBody(req.body)) {
      res.status(400).json({ error: "Invalid request payload." });
      return;
    }

    const model = req.body.model && ALLOWED_MODELS.has(req.body.model) ? req.body.model : DEFAULT_MODEL;
    const instructions = req.body.instructions ?? "";
    const contents = req.body.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let aborted = false;
    const onClose = () => { aborted = true; };
    req.on("close", onClose);

    const writeEvent = (payload: Record<string, unknown>) => {
      if (!aborted && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      const ai = getGeminiClient();
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: instructions ? { systemInstruction: instructions } : undefined,
      });

      for await (const chunk of stream) {
        if (aborted) break;
        const text = chunk.text;
        if (text) writeEvent({ type: "delta", text });
      }

      if (!aborted) writeEvent({ type: "done" });
    } catch (err) {
      if (!aborted) {
        const { message, code } = formatGeminiError(err);
        writeEvent({ type: "error", message, code });
      }
    } finally {
      req.off("close", onClose);
      if (!res.writableEnded) res.end();
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("/{*splat}", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Folio server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
