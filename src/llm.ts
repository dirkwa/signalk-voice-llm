// Minimal OpenAI-compatible chat client. Works with LM Studio, Ollama
// (/v1), llama.cpp server, and the OpenAI/Anthropic-compatible gateways —
// anything that speaks POST /v1/chat/completions.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string; // e.g. http://192.168.0.50:1234/v1
  model: string; // model id as loaded in the server (LM Studio shows it)
  apiKey?: string; // usually unused for local servers
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmResult {
  text: string;
}

/**
 * Ask the LLM for a single completion. Throws on transport/HTTP/timeout error
 * so the caller can surface it (and, per spec, never leave the user without
 * some feedback).
 */
export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
): Promise<LlmResult> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LLM HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("LLM returned an empty response");
    return { text };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM request timed out after ${cfg.timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
