// Shared by the Ask AI panel and Settings: providers, model lists, ChatGPT sign-in, and web Gemini streaming.
export type AiProvider = "chatgpt" | "claude" | "gemini";

export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const CLAUDE_CODE_URL = "https://claude.com/claude-code";
export const GEMINI_CLI_URL = "https://geminicli.com";

export const GEMINI_MODELS = [
  { id: "gemini-4-hydrogen", name: "Gemini 4 Flash" },
  { id: "gemini-3.1-flash-lite", name: "Gemini Flash Lite" },
];

export const GEMINI_CLI_MODELS = [
  { id: "", name: "Default model" },
  ...GEMINI_MODELS,
];

/** Runs the ChatGPT sign-in (it opens the browser); resolves once it's over with the refreshed status. */
export async function signInChatGPT(ai: FolioAi): Promise<{ status: AiStatus; error: string | null }> {
  const result = await ai.signInChatGPT();
  return { status: await ai.status(), error: result.ok ? null : result.error ?? "ChatGPT sign-in failed." };
}

export async function geminiWebStatus(): Promise<{ available: boolean; models: { id: string; name: string }[] }> {
  try {
    const res = await fetch("/api/ai/gemini/status");
    if (!res.ok) return { available: false, models: GEMINI_MODELS };
    const data = await res.json();
    return {
      available: Boolean(data?.available),
      models: Array.isArray(data?.models) && data.models.length ? data.models : GEMINI_MODELS,
    };
  } catch {
    return { available: false, models: GEMINI_MODELS };
  }
}

/** Streams a Gemini answer from the server-side /api/ai/gemini/ask SSE endpoint. */
export async function askGeminiWeb(
  request: { model: string; instructions: string; messages: AiMessage[] },
  onEvent: (event: Omit<AiEvent, "id">) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/ai/gemini/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Gemini couldn't answer (${res.status}). Please try again.`;
    try {
      const json = await res.json();
      if (json?.error) message = json.error;
    } catch {}
    onEvent({ type: "error", message });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        let event: Omit<AiEvent, "id">;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "done" || event.type === "error") finished = true;
        onEvent(event);
      }
    }
  } catch (err) {
    if (signal.aborted) {
      onEvent({ type: "done" });
      return;
    }
    throw err;
  }

  if (!finished) {
    onEvent(signal.aborted ? { type: "done" } : { type: "error", message: "The connection to Gemini ended early. Please try again." });
  }
}
