// Minimal OpenAI-compatible chat client. Works with LM Studio, Ollama
// (/v1), llama.cpp server, and the OpenAI/Anthropic-compatible gateways —
// anything that speaks POST /v1/chat/completions.

// A single tool call the model wants to make. `arguments` is a JSON *string*
// (OpenAI encodes call arguments as text, not a nested object), parsed by the
// caller before dispatch.
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  // Null on an assistant turn that is purely tool calls (the model returns no
  // prose, only tool_calls) — OpenAI sends content:null there.
  content: string | null;
  // Present only on an assistant message that requested tools; echoed back
  // verbatim so the follow-up request is a valid conversation.
  tool_calls?: ToolCall[];
  // Present only on a tool-result message; must match the originating
  // tool_calls[].id so the model can correlate the result.
  tool_call_id?: string;
}

// A tool offered to the model, in OpenAI function-calling shape. `parameters`
// is a JSON Schema — an MCP tool's inputSchema drops straight in here.
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
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

// The raw assistant turn from a tool-enabled call: any prose, any tool the
// model wants to run, and why generation stopped. The loop in tools.ts reads
// all three — content alone is not enough, since a tool turn has none.
export interface LlmToolTurn {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

// Shape of the one message we read out of an OpenAI chat completion. Kept local
// so both entry points parse the response the same way.
interface ChatCompletion {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }[];
}

// POST a chat completion and return the parsed response. Shared by chat() and
// chatWithTools(): builds the URL, applies the timeout, sends the body, and
// turns a non-OK status or timeout into a descriptive Error. The body is passed
// in whole so each caller controls whether `tools`/`tool_choice` are present.
async function postCompletion(
  cfg: LlmConfig,
  body: Record<string, unknown>,
): Promise<ChatCompletion> {
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
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `LLM HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
      );
    }
    return (await res.json()) as ChatCompletion;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM request timed out after ${cfg.timeoutMs} ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const data = await postCompletion(cfg, {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
  });
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("LLM returned an empty response");
  return { text };
}

/**
 * Ask the LLM for a completion that MAY call tools. Sends the OpenAI `tools`
 * list and `tool_choice`, and returns the assistant turn whole — its prose, the
 * tool calls it wants to make, and the finish reason. Unlike chat(), an empty
 * `content` is NOT an error here: a pure tool-call turn legitimately has none.
 * The agentic loop (tools.ts) decides what to do next from `toolCalls`.
 */
export async function chatWithTools(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  toolChoice: "auto" | "none" = "auto",
): Promise<LlmToolTurn> {
  const data = await postCompletion(cfg, {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
    tools,
    tool_choice: toolChoice,
  });
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content?.trim() ?? "",
    toolCalls: sanitizeToolCalls(message?.tool_calls),
    finishReason: data.choices?.[0]?.finish_reason ?? "",
  };
}

// The response JSON is untrusted (a flaky local model can emit a malformed
// tool_calls entry). The loop dereferences id / function.name / function.arguments
// on each call, so drop any entry missing those rather than casting blindly and
// dispatching garbage. arguments is normalised to a string ("" when absent) since
// the caller JSON.parses it.
function sanitizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const call = c as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = call.function?.name;
    if (typeof call.id !== "string" || typeof name !== "string") return [];
    const args = call.function?.arguments;
    return [
      {
        id: call.id,
        type: "function" as const,
        function: { name, arguments: typeof args === "string" ? args : "" },
      },
    ];
  });
}
