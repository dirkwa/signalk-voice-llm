// Minimal MCP client over Streamable HTTP (the transport fsk-mcp and most
// remote MCP servers speak). Plain fetch + JSON-RPC 2.0 — no @modelcontextprotocol
// SDK, matching this plugin's zero-dependency, no-SDK ethos (the SDK is ESM-only
// and this plugin is CommonJS). The surface we need is tiny: initialize,
// tools/list, tools/call, and a best-effort close.
//
// Wire contract (see freeboard-sk/dev-tools/fsk-mcp/src/mcp-http.js):
//   - POST the JSON-RPC request to the server URL.
//   - `initialize` must come first, with no session id; the server returns an
//     `Mcp-Session-Id` response header that every later request must echo.
//   - After initialize, send the `notifications/initialized` notification.
//   - Requests must Accept both application/json and text/event-stream. Servers
//     with enableJsonResponse reply as plain JSON; a spec-compliant server may
//     reply as a one-event SSE stream, so we parse either.
//   - An expired/unknown session comes back as an HTTP 4xx; we re-initialize
//     once and retry so a long-idle plugin recovers transparently.

// The MCP protocol revision we implement against. Servers negotiate down if
// they must; fsk-mcp accepts this.
const PROTOCOL_VERSION = "2025-06-18";

// A tool as advertised by tools/list. `inputSchema` is a JSON Schema and drops
// straight into an OpenAI tool's `parameters`.
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// The result of a tools/call: the text parts joined, plus whether the server
// flagged it as an error (so the caller can feed "error: …" back to the model
// rather than treating it as a hard failure).
export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpClientOptions {
  url: string;
  token?: string;
  // Per-request timeout. A tools/call on fsk-mcp relays to a browser tab and
  // can stall, so keep this short and let the loop feed a timeout back to the
  // model as a recoverable tool error.
  timeoutMs: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// The one place we know a server response is a JSON-RPC error is here; keep the
// message extraction in one spot.
function rpcErrorMessage(err: { code: number; message: string }): string {
  return `${err.message} (code ${err.code})`;
}

/**
 * A single MCP server connection. Not thread-safe by design — each voice
 * command runs its tool calls sequentially, and one client instance maps to one
 * server. Construct once per configured server; call connect() before use.
 */
export class McpClient {
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private nextId = 1;
  // The Host header value the server's DNS-rebinding guard expects. Derived from
  // the URL so a loopback fsk-mcp bind (which allow-lists 127.0.0.1:<port> etc.)
  // accepts us; fetch would otherwise send its own Host and could mismatch.
  private readonly hostHeader: string;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.token = opts.token || undefined;
    this.timeoutMs = opts.timeoutMs;
    this.hostHeader = new URL(opts.url).host;
  }

  /** Establish a session: initialize, then notifications/initialized. */
  async connect(): Promise<void> {
    await this.initialize();
  }

  /** List the tools the server offers. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((t) => {
      const tool = t as {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
      };
      if (typeof tool.name !== "string") return [];
      const schema =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} };
      return [
        {
          name: tool.name,
          description:
            typeof tool.description === "string" ? tool.description : undefined,
          inputSchema: schema,
        },
      ];
    });
  }

  /**
   * Call a tool. Returns the joined text content and whether the server marked
   * it an error. Transport/timeout failures throw; a tool the server ran but
   * that failed comes back as { isError: true } so the caller can narrate it.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as { content?: unknown; isError?: unknown } | undefined;
    const parts = Array.isArray(result?.content) ? result!.content : [];
    const text = parts
      .flatMap((p) => {
        const part = p as { type?: unknown; text?: unknown };
        return part.type === "text" && typeof part.text === "string"
          ? [part.text]
          : [];
      })
      .join("\n")
      .trim();
    return { text, isError: result?.isError === true };
  }

  /** Best-effort session teardown. Never throws. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: this.baseHeaders(sid),
      });
    } catch {
      // The server drops idle sessions on its own; a failed DELETE is harmless.
    }
  }

  // --- internals ----------------------------------------------------------

  private baseHeaders(sessionId: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: this.hostHeader,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    return headers;
  }

  private async initialize(): Promise<void> {
    const { response, body } = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "signalk-voice-llm", version: "1" },
        },
      },
      null,
    );
    const sid = response.headers.get("mcp-session-id");
    if (!sid) {
      throw new Error(
        "MCP server did not return an Mcp-Session-Id on initialize",
      );
    }
    this.sessionId = sid;
    const parsed = parseJsonRpc(body);
    if (parsed?.error) {
      throw new Error(
        `MCP initialize failed: ${rpcErrorMessage(parsed.error)}`,
      );
    }
    // Per spec, acknowledge readiness. Fire-and-forget: a server that ignores it
    // still works, and we don't want a flaky notification to fail the session.
    await this.post(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      this.sessionId,
    ).catch(() => undefined);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.sessionId) await this.initialize();
    const send = async () => {
      const { response, body } = await this.post(
        { jsonrpc: "2.0", id: this.nextId++, method, params },
        this.sessionId,
      );
      return { response, body };
    };

    let { response, body } = await send();
    // A 4xx here usually means the session expired or the server restarted.
    // Re-initialize once and retry so a long-idle plugin recovers silently.
    if (response.status >= 400 && response.status < 500) {
      this.sessionId = null;
      await this.initialize();
      ({ response, body } = await send());
    }
    if (!response.ok) {
      throw new Error(
        `MCP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const parsed = parseJsonRpc(body);
    if (!parsed) throw new Error("MCP server returned an unparseable response");
    if (parsed.error) throw new Error(rpcErrorMessage(parsed.error));
    return parsed.result;
  }

  // POST one JSON-RPC message and return the raw Response + decoded body text.
  // Applies the per-request timeout and the session/host/auth headers.
  private async post(
    message: Record<string, unknown>,
    sessionId: string | null,
  ): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.baseHeaders(sessionId),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      // A notification (no id) gets a 202 with an empty body — read defensively.
      const body = await response.text().catch(() => "");
      return { response, body };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`MCP request timed out after ${this.timeoutMs} ms`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Decode a Streamable-HTTP response body into one JSON-RPC message. A server
// with enableJsonResponse returns plain JSON; a spec-compliant streaming server
// returns SSE (one or more `data:` lines carrying JSON). Handle both, and take
// the last data event that parses to a JSON-RPC message with a matching shape.
function parseJsonRpc(body: string): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  // Plain JSON path.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return asJsonRpc(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  // SSE path: collect the JSON payloads of `data:` lines, newest wins.
  let found: JsonRpcResponse | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    try {
      const candidate = asJsonRpc(JSON.parse(m[1]));
      if (candidate) found = candidate;
    } catch {
      // Not a JSON-RPC data line (e.g. a keep-alive comment) — skip it.
    }
  }
  return found;
}

function asJsonRpc(value: unknown): JsonRpcResponse | null {
  if (value && typeof value === "object" && "jsonrpc" in value) {
    return value as JsonRpcResponse;
  }
  return null;
}
