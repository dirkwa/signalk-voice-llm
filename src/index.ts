import { chat, ChatMessage, LlmConfig } from "./llm";
import { buildContext, ContextGroups, SelfPathReader } from "./context";
import {
  fetchWeather,
  WeatherApiLike,
  WeatherConfig,
  WEATHER_DEFAULTS,
} from "./weather";
import { PROVIDERS, ProviderId, resolveBaseUrl } from "./providers";
import { Toolset, runConversation, ToolsConfig } from "./tools";

// ---------------------------------------------------------------------------
// SignalK plugin: voice.command -> LLM -> say()
// ---------------------------------------------------------------------------

const PLUGIN_ID = "signalk-voice-llm";

interface VoiceCommand {
  id?: string;
  text?: string;
  satellite?: string;
  language?: string;
}

type SayFn = (opts: {
  text: string;
  targets?: string[];
  priority?: "normal" | "urgent";
}) => Promise<{ ok: boolean; queued: string[]; errors?: unknown[] }>;

interface App {
  debug: (msg: string) => void;
  error: (msg: string) => void;
  setPluginStatus?: (msg: string) => void;
  setPluginError?: (msg: string) => void;
  getSelfPath: (path: string) => unknown;
  // SignalK Weather API — present when a weather-provider plugin is installed
  // (e.g. @signalk/open-meteo-provider). Absent/throwing when none is; the
  // weather block is best-effort either way.
  weatherApi?: WeatherApiLike;
  subscriptionmanager?: {
    subscribe: (
      sub: unknown,
      unsub: unknown[],
      onError: (e: unknown) => void,
      onDelta: (delta: any) => void,
    ) => void;
  };
  onPropertyValues?: (
    name: string,
    // PropertyValues replays history: the callback receives the full array of
    // emissions (newest last), each entry shaped { value, ... }.
    cb: (history: unknown[]) => void,
  ) => (() => void) | void;
}

interface Config {
  llm: {
    // Which OpenAI-compatible backend to use. A remote preset (groq/cerebras/
    // openrouter) overrides baseUrl with its fixed host; local/custom use the
    // baseUrl below. Absent in configs predating this field → treated as local.
    provider: ProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  systemPrompt: string;
  context: ContextGroups;
  // Live weather + sea state for the boat's position, via the SignalK Weather
  // API (a weather-provider plugin supplies the data). Tides come from
  // environment.tide.* in the boat-data snapshot, not from here.
  weather: {
    enabled: boolean;
  } & WeatherConfig;
  // Let the model call tools on configured MCP servers (e.g. fsk-mcp driving
  // the chart plotter). Off by default; a no-op with no servers configured.
  tools: ToolsConfig;
  replyTargetOriginOnly: boolean;
  speakErrors: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful voice assistant aboard a boat. Answer whatever the " +
  "skipper asks — sailing, navigation, destinations, geography, weather, " +
  "cooking, general knowledge, anything — the same way a knowledgeable " +
  "friend would; you are not restricted to boat topics. Live boat data " +
  "may be provided below: use it when the question is about the vessel, " +
  "and prefer nautical units (knots, metres, degrees) for boat matters. " +
  "Your reply is read aloud by a text-to-speech voice, so write plain " +
  "speakable prose only — no markdown, no bullet lists, no emoji, no " +
  "headings — and keep it a natural spoken length: a sentence or two for " +
  "simple questions, a short paragraph when the topic deserves it. The " +
  "question was transcribed from speech and may be misheard, so interpret " +
  'it sensibly in a nautical context (e.g. "debt" likely means "depth").';

// Appended to the system prompt only when tools are active, so the model knows
// how to use them and — crucially for a spoken assistant — that tool results
// are data for it, not text to read aloud.
const TOOL_MODE_PROMPT =
  "\n\nYou can use tools to act on the skipper's behalf (for example to control " +
  "the chart plotter). Call a tool only when the request needs it; answer " +
  "directly otherwise. Tool results are data for you, not for the skipper — " +
  "never read JSON, ids, or coordinates aloud; once you've done what was asked, " +
  "report the outcome in one short spoken sentence. Before an action that " +
  "changes the boat's state (creating or activating a route, sending a value), " +
  "make sure that is clearly what was asked.";

// Signal K does not seed schema defaults at runtime: start() receives whatever
// is in the saved config, which is `{}` on first enable and may be a partial
// object after a schema gains new fields. These defaults are the single source
// of truth — the JSON Schema below reads from them — and are spread over the
// incoming config in start().
const SCHEMA_DEFAULTS: Config = {
  llm: {
    provider: "local",
    baseUrl: "http://192.168.0.50:1234/v1",
    model: "qwen2.5-7b-instruct",
    apiKey: "",
    temperature: 0.4,
    // Room for a natural spoken paragraph on a broader question (was 200,
    // which truncated anything beyond a couple of sentences). The prompt, not
    // this cap, is what keeps replies conversational rather than essay-length.
    maxTokens: 500,
    timeoutMs: 30000,
  },
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  context: {
    navigation: true,
    anchor: true,
    environment: true,
    electrical: true,
  },
  weather: {
    enabled: true,
    ...WEATHER_DEFAULTS,
  },
  tools: {
    // Off by default: small local models are unreliable at tool-calling, and
    // there is nothing to call until a server is configured. Opt in when
    // pointing at a capable model + an MCP server.
    enabled: false,
    maxIterations: 3,
    conversationBudgetMs: 45000,
    callTimeoutMs: 8000,
    mcpServers: [],
  },
  replyTargetOriginOnly: true,
  speakErrors: true,
};

// Deep-merge for the one nested level this config has. A plain spread would
// let a saved config that predates a new llm.* field leave that field
// undefined, which is the same crash in slower motion.
function withDefaults(incoming: Partial<Config> | undefined): Config {
  const cfg = incoming ?? {};
  return {
    ...SCHEMA_DEFAULTS,
    ...cfg,
    llm: { ...SCHEMA_DEFAULTS.llm, ...(cfg.llm ?? {}) },
    context: { ...SCHEMA_DEFAULTS.context, ...(cfg.context ?? {}) },
    weather: { ...SCHEMA_DEFAULTS.weather, ...(cfg.weather ?? {}) },
    // mcpServers is an array: a plain spread replaces it wholesale, which is
    // the intended semantic — a saved server list is not deep-merged.
    tools: { ...SCHEMA_DEFAULTS.tools, ...(cfg.tools ?? {}) },
  };
}

module.exports = function (app: App) {
  let unsubscribes: Array<() => void> = [];
  let say: SayFn | null = null;
  let running = false;
  // The live MCP tool connections for this run, or null when tools are off /
  // unconfigured. Built asynchronously in start(); torn down in stop().
  let toolset: Toolset | null = null;
  // Bumped on every start()/stop() so a connect() that finishes after a restart
  // doesn't publish a stale toolset.
  let toolsGeneration = 0;

  const plugin = {
    id: PLUGIN_ID,
    name: "Voice Assistant (LLM)",
    description:
      "Answers voice commands with a local or remote LLM and speaks the reply.",

    schema: () => ({
      type: "object",
      properties: {
        llm: {
          type: "object",
          title: "LLM server (OpenAI-compatible)",
          properties: {
            provider: {
              type: "string",
              title: "Provider",
              description:
                "Local = your on-boat server (LM Studio/Ollama). Groq/Cerebras/OpenRouter = free, fast hosted models (need internet + an API key; the question and boat data leave the boat). Custom = any other OpenAI-compatible URL. A hosted provider overrides the Base URL below.",
              enum: Object.keys(PROVIDERS),
              enumNames: Object.values(PROVIDERS).map((p) => p.label),
              default: SCHEMA_DEFAULTS.llm.provider,
            },
            baseUrl: {
              type: "string",
              title: "Base URL (local / custom only)",
              description:
                "Used when Provider is Local or Custom (a hosted provider ignores this). LM Studio: http://<windows-ip>:1234/v1 · Ollama: http://<host>:11434/v1",
              default: SCHEMA_DEFAULTS.llm.baseUrl,
            },
            model: {
              type: "string",
              title: "Model",
              description:
                "Model id for the chosen provider. Local (LM Studio) shows it at the top. Groq: llama-3.3-70b-versatile · Cerebras: llama-3.3-70b · OpenRouter: meta-llama/llama-3.3-70b-instruct:free",
              default: SCHEMA_DEFAULTS.llm.model,
            },
            apiKey: {
              type: "string",
              title: "API key",
              description:
                "Empty for local servers. Required for hosted providers — create one in the provider's console (Groq/Cerebras/OpenRouter all offer a free tier).",
              default: SCHEMA_DEFAULTS.llm.apiKey,
            },
            temperature: {
              type: "number",
              title: "Temperature",
              default: SCHEMA_DEFAULTS.llm.temperature,
            },
            maxTokens: {
              type: "number",
              title: "Max reply tokens",
              default: SCHEMA_DEFAULTS.llm.maxTokens,
            },
            timeoutMs: {
              type: "number",
              title: "Request timeout (ms)",
              default: SCHEMA_DEFAULTS.llm.timeoutMs,
            },
          },
        },
        systemPrompt: {
          type: "string",
          title: "System prompt",
          description:
            "How the assistant should behave. The default lets it discuss any topic (not just the boat) in a natural spoken length; edit to make it terser, more formal, or boat-focused. Keep it speakable — no markdown, since replies are read aloud.",
          default: SCHEMA_DEFAULTS.systemPrompt,
        },
        context: {
          type: "object",
          title: "Boat data the assistant can use",
          properties: {
            navigation: {
              type: "boolean",
              title: "Navigation (position, speed, course, depth)",
              default: SCHEMA_DEFAULTS.context.navigation,
            },
            anchor: {
              type: "boolean",
              title: "Anchor (state, radius, drag)",
              default: SCHEMA_DEFAULTS.context.anchor,
            },
            environment: {
              type: "boolean",
              title: "Environment / wind",
              default: SCHEMA_DEFAULTS.context.environment,
            },
            electrical: {
              type: "boolean",
              title: "Electrical / tanks",
              default: SCHEMA_DEFAULTS.context.electrical,
            },
          },
        },
        weather: {
          type: "object",
          title: "Weather & sea state (SignalK Weather API)",
          description:
            "Adds a live forecast + sea state for the boat's position so the assistant can answer weather questions. Data comes from a SignalK weather-provider plugin (e.g. @signalk/open-meteo-provider) — install one, or this section is a no-op. Tides come from a tides plugin (e.g. signalk-tides) via environment.tide.*, shown with the boat data.",
          properties: {
            enabled: {
              type: "boolean",
              title: "Enable weather & sea state",
              default: SCHEMA_DEFAULTS.weather.enabled,
            },
            forecastHours: {
              type: "number",
              title: "Forecast window (intervals)",
              minimum: 1,
              maximum: 48,
              description:
                "How many forecast intervals ahead to summarise (1–48; the provider sets the interval length, typically hourly).",
              default: SCHEMA_DEFAULTS.weather.forecastHours,
            },
            marine: {
              type: "boolean",
              title: "Include sea state (waves & swell)",
              description:
                "Also summarise wave height/period and swell when the weather provider supplies marine data.",
              default: SCHEMA_DEFAULTS.weather.marine,
            },
          },
        },
        tools: {
          type: "object",
          title: "Tools (MCP)",
          description:
            "Let the assistant call tools on MCP servers you configure — e.g. fsk-mcp to drive the Freeboard-SK chart plotter (pan/zoom, routes, points of interest). Off by default. NOTE: tool-calling needs a capable model — small local models (e.g. qwen2.5-7b) are unreliable at it; use a hosted model (Groq/Cerebras 70B) or a tool-tuned local model. With no servers listed this section does nothing.",
          properties: {
            enabled: {
              type: "boolean",
              title: "Enable tool-calling",
              default: SCHEMA_DEFAULTS.tools.enabled,
            },
            maxIterations: {
              type: "number",
              title: "Max tool rounds per command",
              minimum: 1,
              maximum: 10,
              description:
                "How many times the model may call tools before it must answer (keeps spoken replies prompt).",
              default: SCHEMA_DEFAULTS.tools.maxIterations,
            },
            conversationBudgetMs: {
              type: "number",
              title: "Overall time budget (ms)",
              minimum: 5000,
              maximum: 120000,
              description:
                "Wall-clock cap for the whole tool conversation; when it passes, the assistant summarises what it has.",
              default: SCHEMA_DEFAULTS.tools.conversationBudgetMs,
            },
            callTimeoutMs: {
              type: "number",
              title: "Per tool-call timeout (ms)",
              minimum: 1000,
              maximum: 30000,
              description:
                "Timeout for a single tool call. fsk-mcp relays to a browser tab and can stall, so keep this short.",
              default: SCHEMA_DEFAULTS.tools.callTimeoutMs,
            },
            mcpServers: {
              type: "array",
              title: "MCP servers",
              description:
                "MCP servers to expose as tools. fsk-mcp defaults to http://127.0.0.1:3013/mcp and needs a Freeboard-SK tab open to answer.",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    title: "Name",
                    description:
                      "Short label used to namespace this server's tools, e.g. fsk.",
                  },
                  url: {
                    type: "string",
                    title: "URL",
                    description: "Streamable-HTTP MCP endpoint, e.g. /mcp.",
                  },
                  token: {
                    type: "string",
                    title: "Token (optional)",
                    description:
                      "Bearer token, if the server requires one (sent as Authorization: Bearer …).",
                  },
                  enabled: {
                    type: "boolean",
                    title: "Enabled",
                    default: true,
                  },
                },
                required: ["name", "url"],
              },
              default: SCHEMA_DEFAULTS.tools.mcpServers,
            },
          },
        },
        replyTargetOriginOnly: {
          type: "boolean",
          title: "Reply only to the satellite that asked",
          description: "If off, the answer plays on all satellites.",
          default: SCHEMA_DEFAULTS.replyTargetOriginOnly,
        },
        speakErrors: {
          type: "boolean",
          title: "Speak errors aloud",
          description:
            "If the LLM is unreachable, say a short spoken error instead of staying silent.",
          default: SCHEMA_DEFAULTS.speakErrors,
        },
      },
    }),

    start(incoming: Partial<Config>) {
      running = true;
      // Signal K hands us the raw saved config — `{}` on first enable. Never
      // read a nested field off it directly; see SCHEMA_DEFAULTS.
      const config = withDefaults(incoming);
      // Diagnostic surfaced via status (readable over the API without the
      // plugin debug flag): reflects whether the say() handle was acquired.
      let sayAcquired = false;
      const activeBaseUrl = resolveBaseUrl(
        config.llm.provider,
        config.llm.baseUrl,
      );
      const refreshStatus = () => {
        app.setPluginStatus?.(
          `${sayAcquired ? "say() ready" : "waiting for signalk-wyoming say()"} — LLM ${config.llm.provider}:${activeBaseUrl} (${config.llm.model})`,
        );
      };

      // --- Acquire the say() handle from signalk-wyoming via PropertyValues.
      if (typeof app.onPropertyValues === "function") {
        app.onPropertyValues("signalk-wyoming.api", (history) => {
          // History replays newest-last; take the latest emission that carries
          // a callable say handle. Entries are { value: {version, say}, ... }.
          if (!Array.isArray(history)) return;
          for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i] as { value?: { say?: SayFn } } | null;
            const api = entry?.value;
            if (api && typeof api.say === "function") {
              say = api.say;
              sayAcquired = true;
              refreshStatus();
              return;
            }
          }
        });
      } else {
        app.error(
          "app.onPropertyValues unavailable — cannot reach signalk-wyoming say()",
        );
      }

      // --- Build the MCP toolset (async: it connects + discovers tools).
      // Off unless enabled AND at least one enabled server is configured, so a
      // default install is a byte-for-byte no-op on the existing chat path. A
      // server that fails to connect (e.g. fsk-mcp with no Freeboard tab yet)
      // is skipped inside connect(); we just end up with no tools.
      const toolsCfg = config.tools;
      const wantTools =
        toolsCfg.enabled &&
        toolsCfg.mcpServers.some((s) => s.enabled !== false && s.url);
      // A generation guard: if stop()/start() cycles while connect() is in
      // flight, don't publish (or leak) a toolset from the old generation.
      const myGeneration = ++toolsGeneration;
      if (wantTools) {
        const built = new Toolset(
          toolsCfg.mcpServers,
          toolsCfg.callTimeoutMs,
          (m) => app.debug(m),
        );
        void built
          .connect()
          .then(() => {
            if (myGeneration !== toolsGeneration || !running) {
              // Superseded by a restart/stop while connecting — discard.
              return built.close();
            }
            toolset = built;
            app.debug(
              built.hasTools
                ? `tools: ${built.tools.length} available`
                : "tools: enabled but no server answered",
            );
          })
          .catch((err) => {
            app.error(
              `tool setup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      // --- Subscribe to voice.command deltas.
      const reader: SelfPathReader = { get: (p) => app.getSelfPath(p) };

      const onCommand = async (cmd: VoiceCommand) => {
        const text = (cmd.text ?? "").trim();
        if (!text) return;
        app.debug(`voice.command: "${text}" (sat=${cmd.satellite ?? "?"})`);
        app.setPluginStatus?.(`thinking: "${text.slice(0, 40)}"`);

        const targets =
          config.replyTargetOriginOnly && cmd.satellite
            ? [cmd.satellite]
            : undefined;

        const llmCfg: LlmConfig = {
          baseUrl: activeBaseUrl,
          model: config.llm.model,
          apiKey: config.llm.apiKey || undefined,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          timeoutMs: config.llm.timeoutMs,
        };

        const boat = buildContext(reader, config.context);

        // Add a live forecast + sea state for the current position from the
        // SignalK Weather API (best-effort — never throws, returns "" when off,
        // no provider is registered, or the position is unknown). Tides are
        // already in `boat` via environment.tide.*.
        let weather = "";
        if (config.weather.enabled) {
          // getSelfPath may return a bare value OR a SK node ({ value, ... }).
          // Guard with typeof before `in` — a truthy primitive (malformed/
          // legacy delta) would make `"value" in raw` throw a TypeError, and
          // this runs under `void onCommand(...)`, so a throw becomes an
          // unhandled rejection (violating "never crash signalk-server").
          const raw: unknown = app.getSelfPath("navigation.position");
          const node =
            raw !== null && typeof raw === "object" && "value" in raw
              ? (raw as { value?: unknown }).value
              : raw;
          const p =
            node !== null && typeof node === "object"
              ? (node as { latitude?: unknown; longitude?: unknown })
              : undefined;
          if (
            p &&
            typeof p.latitude === "number" &&
            typeof p.longitude === "number"
          ) {
            weather = await fetchWeather(
              p.latitude,
              p.longitude,
              config.weather as WeatherConfig,
              app.weatherApi,
            );
          }
        }

        // Use the tool loop only when a toolset actually discovered tools;
        // otherwise the call is the unchanged single-shot chat path.
        const activeTools = toolset && toolset.hasTools ? toolset : null;

        const system =
          (config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
          (boat ? `\n\nCurrent boat data:\n${boat}` : "") +
          (weather
            ? `\n\nWeather and sea conditions at the boat:\n${weather}`
            : "") +
          (activeTools ? TOOL_MODE_PROMPT : "");
        const messages: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: text },
        ];

        let reply: string;
        try {
          reply = activeTools
            ? (
                await runConversation(llmCfg, messages, activeTools, {
                  maxIterations: toolsCfg.maxIterations,
                  conversationBudgetMs: toolsCfg.conversationBudgetMs,
                  now: () => Date.now(),
                  stillRunning: () => running,
                  log: (m) => app.debug(m),
                })
              ).text
            : (await chat(llmCfg, messages)).text;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          app.error(`LLM failed: ${msg}`);
          app.setPluginError?.(`LLM error: ${msg}`);
          if (config.speakErrors && say) {
            await say({
              text: "Sorry, I couldn't reach the assistant.",
              targets,
            }).catch(() => undefined);
          }
          return;
        }

        // The LLM call above can take many seconds. If the plugin was stopped
        // while it was in flight, drop the reply rather than speaking into a
        // boat whose owner just disabled the assistant.
        if (!running) {
          app.debug(
            "dropping reply — plugin stopped while the LLM was working",
          );
          return;
        }

        // The tool loop returns "" when it was dropped mid-flight; with the
        // plugin still running that means nothing to say. Don't speak silence.
        if (!reply) {
          app.debug("empty reply — nothing to speak");
          return;
        }

        app.debug(`LLM reply: "${reply}"`);
        app.setPluginStatus?.(`spoke: "${reply.slice(0, 40)}"`);

        if (!say) {
          app.error("no say() handle yet — is signalk-wyoming running?");
          return;
        }
        try {
          const res = await say({ text: reply, targets });
          if (!res.ok) app.debug(`say() partial: ${JSON.stringify(res)}`);
        } catch (err) {
          app.error(
            `say() failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      if (app.subscriptionmanager) {
        const subscription = {
          context: "vessels.self",
          subscribe: [{ path: "voice.command", policy: "instant" }],
        };
        app.subscriptionmanager.subscribe(
          subscription,
          unsubscribes as any,
          (err) => app.error(`subscription error: ${String(err)}`),
          (delta: any) => {
            for (const upd of delta.updates ?? []) {
              for (const vp of upd.values ?? []) {
                if (vp.path === "voice.command" && vp.value) {
                  void onCommand(vp.value as VoiceCommand);
                }
              }
            }
          },
        );
        app.debug("subscribed to voice.command");
      } else {
        app.error(
          "subscriptionmanager unavailable — cannot read voice.command",
        );
      }

      refreshStatus();
    },

    stop() {
      running = false;
      // Tear down MCP connections and invalidate any in-flight connect() so it
      // can't publish a stale toolset after a restart. Unlike say(), these are
      // per-run sockets with nothing to preserve across a stop()/start().
      toolsGeneration++;
      if (toolset) {
        void toolset.close();
        toolset = null;
      }
      // Deliberately keep `say`: SignalK keeps the plugin module loaded across
      // a stop()/start() cycle (e.g. a config change), but PropertyValues does
      // not reliably re-deliver signalk-wyoming.api's history to the
      // re-subscribing plugin. Holding the last-known handle keeps voice
      // replies working after a config change without needing to restart
      // signalk-wyoming. The facade is stable across wyoming restarts and
      // rejects safely if wyoming is stopped, so a stale handle fails cleanly.
      unsubscribes.forEach((f) => {
        try {
          f();
        } catch {
          /* ignore */
        }
      });
      unsubscribes = [];
      app.debug("stopped");
    },
  };

  return plugin;
};
