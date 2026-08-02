import { chat, ChatMessage, LlmConfig } from "./llm";
import { buildContext, ContextGroups, SelfPathReader } from "./context";
import { fetchWeather, WeatherConfig, WEATHER_DEFAULTS } from "./weather";
import { PROVIDERS, ProviderId, resolveBaseUrl } from "./providers";

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
  // Live weather forecast (Open-Meteo) for the boat's position — the local LLM
  // has no internet, so this fetches the forecast and feeds it as context.
  weather: {
    enabled: boolean;
  } & WeatherConfig;
  replyTargetOriginOnly: boolean;
  speakErrors: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are the voice assistant on a boat. Answer the skipper's spoken " +
  "question briefly and clearly — your reply is read aloud by a " +
  "text-to-speech voice, so keep it to one or two short sentences, no " +
  "markdown, no lists, no emoji. If live boat data is provided below, use " +
  "it to answer questions about the vessel; if you don't have the data, say " +
  "so plainly. Prefer nautical units (knots, metres, degrees).";

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
    maxTokens: 200,
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
  };
}

module.exports = function (app: App) {
  let unsubscribes: Array<() => void> = [];
  let say: SayFn | null = null;
  let running = false;

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
            "How the assistant should behave. Keep replies short — they are spoken.",
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
          title: "Weather forecast (Open-Meteo, no API key)",
          description:
            "Fetches a live forecast for the boat's position so the assistant can answer weather questions — the local LLM has no internet on its own.",
          properties: {
            enabled: {
              type: "boolean",
              title: "Enable weather forecast",
              default: SCHEMA_DEFAULTS.weather.enabled,
            },
            forecastHours: {
              type: "number",
              title: "Forecast window (hours)",
              description: "How far ahead to summarise (1–48).",
              default: SCHEMA_DEFAULTS.weather.forecastHours,
            },
            timeoutMs: {
              type: "number",
              title: "Forecast request timeout (ms)",
              default: SCHEMA_DEFAULTS.weather.timeoutMs,
            },
            cacheMs: {
              type: "number",
              title: "Forecast cache (ms)",
              description:
                "Reuse the last forecast for this long instead of refetching. 0 disables.",
              default: SCHEMA_DEFAULTS.weather.cacheMs,
            },
            baseUrl: {
              type: "string",
              title: "Open-Meteo base URL",
              description:
                "The forecast API host. Leave as the default unless you run a self-hosted Open-Meteo instance.",
              default: SCHEMA_DEFAULTS.weather.baseUrl,
            },
            marine: {
              type: "boolean",
              title: "Include sea state (swell & waves)",
              description:
                "Also fetch the Open-Meteo Marine forecast (wave height/period, swell) for the boat's position. Free, no API key.",
              default: SCHEMA_DEFAULTS.weather.marine,
            },
            marineBaseUrl: {
              type: "string",
              title: "Open-Meteo Marine base URL",
              description:
                "The marine API host (a different subdomain from the forecast host). Leave as the default unless self-hosting.",
              default: SCHEMA_DEFAULTS.weather.marineBaseUrl,
            },
            tidesApiKey: {
              type: "string",
              title: "WorldTides API key (optional — enables tides)",
              description:
                "Tides need a key (no free keyless source exists). Leave empty to skip tides; weather and sea state still work. Get a free key at worldtides.info to add next high/low water.",
              default: SCHEMA_DEFAULTS.weather.tidesApiKey,
            },
            tidesBaseUrl: {
              type: "string",
              title: "WorldTides base URL",
              description:
                "The tides API host. Leave as the default unless you proxy it.",
              default: SCHEMA_DEFAULTS.weather.tidesBaseUrl,
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

        // Fetch a live forecast for the current position (best-effort — never
        // throws, returns "" when off / unavailable). The local LLM can't
        // reach the internet, so this is how it answers weather questions.
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
            );
          }
        }

        const system =
          (config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
          (boat ? `\n\nCurrent boat data:\n${boat}` : "") +
          (weather
            ? `\n\nWeather and sea conditions at the boat:\n${weather}`
            : "");
        const messages: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: text },
        ];

        let reply: string;
        try {
          reply = (await chat(llmCfg, messages)).text;
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
