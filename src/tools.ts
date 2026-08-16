// The tool-calling orchestration layer: connect to configured MCP servers,
// discover their tools, offer them to the LLM as OpenAI functions, and run the
// bounded agentic loop that lets the model call a tool, see the result, and
// answer in speakable prose.
//
// This is where the loop lives — llm.ts stays a pure single-shot transport and
// mcp.ts stays a pure JSON-RPC client, so each is independently testable. index.ts
// builds one Toolset per start() and calls runConversation() per voice command.

import {
  chatWithTools,
  type ChatMessage,
  type LlmConfig,
  type ToolSpec,
} from "./llm";
import { McpClient, type McpTool } from "./mcp";
import { describePosition } from "./geocode";

/** A live position supplier, so where_am_i works with no arguments. */
export interface PositionSupplier {
  (): { latitude?: number; longitude?: number };
}

/** Accept only finite numbers from model-supplied JSON. */
function numArg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// One configured MCP server.
export interface McpServerConfig {
  name: string; // namespace key, e.g. "fsk"
  url: string;
  token?: string;
  enabled?: boolean; // default true
}

export interface ToolsConfig {
  enabled: boolean;
  maxIterations: number;
  conversationBudgetMs: number;
  callTimeoutMs: number;
  mcpServers: McpServerConfig[];
}

// The tool_calls a name maps back to: either an MCP server client plus the
// ORIGINAL (un-namespaced) tool name, or a local handler that runs in-process.
type Dispatch =
  | { kind: "mcp"; client: McpClient; toolName: string }
  | { kind: "local"; run: (args: Record<string, unknown>) => string };

// OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$. Server names and tool
// names are joined with a "__" delimiter; sanitise the joined result and keep a
// map back to the real dispatch so we can undo it when the model calls it.
const NAME_RE = /[^a-zA-Z0-9_-]/g;

function sanitize(name: string): string {
  return name.replace(NAME_RE, "_");
}

// A short line an LLM can log/say if the whole thing goes sideways. Speakable.
const GIVE_UP = "Sorry, I couldn't finish that.";

/**
 * Owns the live MCP connections and the discovered tool surface for one plugin
 * run. Construct with the enabled server configs, call connect() once, then
 * reuse across voice commands. close() on plugin stop().
 */
// Cap the number of tools accepted from any one server. The full spec array —
// each tool's name, description, and inputSchema — is sent on EVERY LLM turn, so
// an unbounded surface grows the request per voice command and eats the token
// budget the boat snapshot and the reply need. A server with more tools than
// this has the excess dropped (and logged); 32 is far above fsk-mcp's 16.
const MAX_TOOLS_PER_SERVER = 32;

export class Toolset {
  private readonly clients: McpClient[] = [];
  // OpenAI tool specs offered to the model (namespaced names).
  private specs: ToolSpec[] = [];
  // Namespaced function name -> how to actually call it.
  private readonly dispatch = new Map<string, Dispatch>();
  // Set by close(): a retry still in flight must not publish tools into a
  // Toolset the plugin already tore down.
  private closed = false;

  // Connection-retry tuning. Defaults cover the boot race (fsk-mcp binds a
  // couple of seconds after we start); tests override them to run fast.
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly callTimeoutMs: number,
    private readonly log: (msg: string) => void = () => {},
    retry: { maxAttempts?: number; backoffMs?: number } = {},
    private readonly position?: PositionSupplier,
  ) {
    this.maxAttempts = retry.maxAttempts ?? 5;
    this.backoffMs = retry.backoffMs ?? 2000;
  }

  /** True once at least one tool was discovered — the loop is only worth
   * running when there is something to call. */
  get hasTools(): boolean {
    return this.specs.length > 0;
  }

  get tools(): ToolSpec[] {
    return this.specs;
  }

  /**
   * Only the tools discovered from MCP servers — the local in-process tools are
   * always present and would otherwise mask "no server answered" in both the
   * per-server cap accounting and the startup log.
   */
  get mcpTools(): ToolSpec[] {
    return this.specs.filter(
      (s) => this.dispatch.get(s.function.name)?.kind === "mcp",
    );
  }

  /**
   * Connect to every enabled server and discover its tools. Best-effort per
   * server: a server that fails to connect or list is logged and skipped, so
   * one dead server (e.g. fsk-mcp with no Freeboard tab yet) doesn't sink the
   * others. Never throws.
   */
  async connect(): Promise<void> {
    // Idempotent: the caller may have registered these already to publish the
    // offline tools without waiting for the servers below.
    this.registerLocalTools();
    for (const server of this.servers) {
      if (this.closed) return;
      if (server.enabled === false) continue;
      await this.connectServer(server);
    }
  }

  /**
   * In-process tools, available with no MCP server configured and no network.
   *
   * where_am_i exists because small models answer coordinate-geography
   * questions by guessing: given the boat's real position in Fiji, qwen2.5-7b
   * confidently placed us near Brisbane. A lookup cannot be wrong that way.
   *
   * Public and idempotent so the plugin can publish the offline tools up front
   * rather than waiting out MCP connection retries; connect() calls it too, so
   * a caller that doesn't need that keeps working unchanged. Calling it twice
   * must not offer the tool twice — a duplicate function name in the specs
   * array is an invalid request to the model.
   */
  registerLocalTools(): void {
    if (this.closed) return;
    if (this.dispatch.has("where_am_i")) return;
    this.dispatch.set("where_am_i", {
      kind: "local",
      run: (args) => {
        // A coordinate is a PAIR. Falling back per-component would fuse a
        // model-supplied latitude with the boat's live longitude and answer
        // confidently about a place neither of them describes — the exact
        // failure this tool exists to prevent, but harder to catch because
        // the result reads as authoritative ("open ocean").
        const hasLat = args["latitude"] !== undefined;
        const hasLon = args["longitude"] !== undefined;
        let lat: number | undefined;
        let lon: number | undefined;
        if (hasLat || hasLon) {
          // Explicit coordinates: both must be present and finite, or reject.
          lat = numArg(args["latitude"]);
          lon = numArg(args["longitude"]);
          if (lat === undefined || lon === undefined) {
            return (
              "error: latitude and longitude must be supplied together as " +
              "finite numbers; omit both to use the vessel's position"
            );
          }
        } else {
          // The model is told to pass the position from the boat snapshot, but
          // it routinely omits arguments entirely — fall back to the live
          // position the plugin already has rather than failing the call.
          const live = this.position?.();
          lat = numArg(live?.latitude);
          lon = numArg(live?.longitude);
          if (lat === undefined || lon === undefined) {
            return "error: no position available (no GPS fix and none supplied)";
          }
        }
        try {
          return describePosition(lat, lon);
        } catch (err) {
          // A RangeError here means the model sent nonsense (often lat/long
          // swapped); say so, so it can retry rather than narrate a bad answer.
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    this.specs.push({
      type: "function",
      function: {
        name: "where_am_i",
        description:
          "Resolve a latitude/longitude to the country or maritime zone that " +
          "contains it. Use this for ANY question about what country, waters, " +
          "or territory the vessel is in — do not answer from the coordinates " +
          "yourself. Works offline. Defaults to the vessel's current position " +
          "when no arguments are given.",
        parameters: {
          type: "object",
          properties: {
            latitude: {
              type: "number",
              description:
                "Decimal degrees, -90..90. Omit to use the vessel's.",
            },
            longitude: {
              type: "number",
              description:
                "Decimal degrees, -180..180. Omit to use the vessel's.",
            },
          },
          required: [],
        },
      },
    });
  }

  // Connect one server, retrying a failed connection a few times. On a fresh
  // boot the MCP server (e.g. fsk-mcp) often isn't listening yet when we start —
  // both plugins come up in parallel and its async bring-up loses the race — so
  // a single attempt would give a tools-less session for the whole run. A short
  // bounded backoff closes that window without blocking start() meaningfully
  // (this runs off the start() path). A server that is genuinely absent just
  // exhausts the retries and is skipped, exactly as before.
  private async connectServer(server: McpServerConfig): Promise<void> {
    const MAX_ATTEMPTS = this.maxAttempts;
    const BACKOFF_MS = this.backoffMs;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.closed) return;
      const client = new McpClient({
        url: server.url,
        token: server.token,
        timeoutMs: this.callTimeoutMs,
      });
      try {
        await client.connect();
        const tools = await client.listTools();
        // A stop()/reconfigure may have closed us while this attempt was in
        // flight. Don't register into (or leak a live client into) a torn-down
        // Toolset — tear this connection down instead.
        if (this.closed) {
          await client.close().catch(() => undefined);
          return;
        }
        this.register(server.name, client, tools);
        this.clients.push(client);
        this.log(`mcp "${server.name}": ${tools.length} tool(s)`);
        return;
      } catch (err) {
        // close() is documented never to throw, but treat it as fallible so a
        // teardown failure can't abort the retry loop or escape connect().
        await client.close().catch(() => undefined);
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) {
          this.log(
            `mcp "${server.name}" not ready (attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}); retrying`,
          );
          await new Promise((r) => setTimeout(r, BACKOFF_MS));
        } else {
          this.log(`mcp "${server.name}" unavailable: ${msg}`);
        }
      }
    }
  }

  private register(
    serverName: string,
    client: McpClient,
    tools: McpTool[],
  ): void {
    let accepted = 0;
    for (const tool of tools) {
      if (accepted >= MAX_TOOLS_PER_SERVER) {
        this.log(
          `mcp "${serverName}": capping at ${MAX_TOOLS_PER_SERVER} tools; dropping "${tool.name}" and any after it`,
        );
        break;
      }
      // Namespace so two servers can expose the same tool name; sanitise for
      // OpenAI's function-name charset, and truncate to the 64-char cap.
      const base = sanitize(`${serverName}__${tool.name}`).slice(0, 64);
      // On a (rare) post-truncation collision, disambiguate deterministically.
      // Always derive from `base` (not the previously-suffixed name) so the
      // suffix doesn't stack, and stays within 64 chars.
      let fnName = base;
      let n = 1;
      while (this.dispatch.has(fnName)) {
        const suffix = `_${n++}`;
        fnName = base.slice(0, 64 - suffix.length) + suffix;
      }
      this.dispatch.set(fnName, { kind: "mcp", client, toolName: tool.name });
      this.specs.push({
        type: "function",
        function: {
          name: fnName,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
      accepted++;
    }
  }

  /**
   * Run one namespaced tool call. Returns a short text result for feeding back
   * to the model. A tool the server ran-but-failed, an unknown name, bad JSON
   * args, or a transport/timeout error all come back as an "error: …" string
   * (never throws) so the model can recover or explain in speech.
   */
  async call(fnName: string, argsJson: string): Promise<string> {
    const target = this.dispatch.get(fnName);
    if (!target) return `error: unknown tool "${fnName}"`;
    let args: Record<string, unknown>;
    try {
      const parsed = argsJson ? JSON.parse(argsJson) : {};
      // MCP tool arguments must be an object; a model can emit a bare scalar or
      // null, which would be an invalid tools/call payload.
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return `error: arguments for "${fnName}" must be a JSON object`;
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return `error: could not parse arguments for "${fnName}"`;
    }
    if (target.kind === "local") {
      // Local handlers are synchronous and self-contained; they return their
      // own error strings rather than throwing, so the loop can feed the text
      // straight back to the model.
      return target.run(args);
    }
    try {
      const res = await target.client.callTool(target.toolName, args);
      if (res.isError) return `error: ${res.text || "tool failed"}`;
      return res.text || "ok";
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Best-effort teardown of every connection. Never throws. */
  async close(): Promise<void> {
    this.closed = true;
    // Snapshot then reset state first, so a rejecting close() can't skip the
    // reset (this runs on the plugin stop() path, which must never throw).
    const clients = this.clients.splice(0);
    this.specs = [];
    this.dispatch.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

// Guard the loop against a very long tool-result string being fed back to the
// model, which it might then try to read aloud. Compact whitespace and cap it —
// the model gets enough to reason about the outcome, not a JSON dump to recite.
function summarize(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 600 ? compact.slice(0, 600) + " …" : compact;
}

export interface ConversationResult {
  text: string;
  // How many tool-calling rounds ran (0 = the model answered without tools).
  rounds: number;
}

/**
 * The bounded agentic loop. Offers `toolset`'s tools to the model; each round,
 * if the model asks for tools, run them and feed the results back; stop when it
 * answers in prose. If the iteration cap is hit with budget to spare, force one
 * tool-free turn so the user still gets a spoken summary. If instead the
 * wall-clock budget runs out, stop without another request and return the fixed
 * fallback line — firing a summary then would overrun the budget.
 *
 * `stillRunning` is checked after every round trip so a reply is dropped if the
 * plugin was stopped mid-loop (the loop can span many seconds). Returns the
 * final speakable text; never throws for a tool failure (those are fed back),
 * only for an unreachable LLM — which the caller already handles.
 */
export async function runConversation(
  cfg: LlmConfig,
  messages: ChatMessage[],
  toolset: Toolset,
  opts: {
    maxIterations: number;
    conversationBudgetMs: number;
    now: () => number;
    stillRunning: () => boolean;
    log?: (msg: string) => void;
  },
): Promise<ConversationResult> {
  const log = opts.log ?? (() => {});
  const deadline = opts.now() + opts.conversationBudgetMs;
  const tools = toolset.tools;
  // Work on our own copy: we append the assistant/tool turns as the loop runs,
  // and the signature must not mutate the caller's array (a caller reusing it
  // across voice commands would otherwise accumulate stale tool history).
  const convo: ChatMessage[] = [...messages];
  let rounds = 0;

  // A per-call LlmConfig whose timeout is clamped to the time left in the whole
  // conversation, so an individual request can't overrun the budget by up to a
  // full cfg.timeoutMs. Returns null when no budget remains at all.
  const withRemainingTimeout = (): LlmConfig | null => {
    const remaining = deadline - opts.now();
    if (remaining <= 0) return null;
    return { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, remaining) };
  };

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    if (!opts.stillRunning()) return { text: "", rounds };
    const roundCfg = withRemainingTimeout();
    if (!roundCfg) break;

    const turn = await chatWithTools(roundCfg, convo, tools, "auto");
    if (!opts.stillRunning()) return { text: "", rounds };

    if (turn.toolCalls.length === 0) {
      // The model answered in prose — done.
      return { text: turn.content || GIVE_UP, rounds };
    }

    rounds++;
    // Echo the assistant's tool-call turn back into the history verbatim, then
    // append each tool result as a role:"tool" message the model can read.
    convo.push({
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls,
    });
    for (const tc of turn.toolCalls) {
      const result = await toolset.call(
        tc.function.name,
        tc.function.arguments,
      );
      log(`tool ${tc.function.name} -> ${summarize(result).slice(0, 80)}`);
      convo.push({
        role: "tool",
        tool_call_id: tc.id,
        content: summarize(result),
      });
    }
    // A round runs the LLM turn plus every tool call, each up to callTimeoutMs,
    // so re-check the budget here too — otherwise a slow round could start
    // another one. Exceeded → fall through to the forced summary turn.
    if (opts.now() >= deadline) break;
  }

  // Cap or budget hit while the model still wanted tools. Force one tool-free
  // turn so it summarises what it has into a spoken answer instead of going
  // silent. If even that yields nothing, fall back to a fixed line.
  if (!opts.stillRunning()) return { text: "", rounds };
  // Only attempt the summary if there's budget left — otherwise firing another
  // request would push total time past the budget the caller set.
  const finalCfg = withRemainingTimeout();
  if (!finalCfg) return { text: GIVE_UP, rounds };
  try {
    const final = await chatWithTools(finalCfg, convo, tools, "none");
    return { text: final.content || GIVE_UP, rounds };
  } catch {
    return { text: GIVE_UP, rounds };
  }
}
