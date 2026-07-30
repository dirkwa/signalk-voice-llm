import { chat, ChatMessage, LlmConfig } from "./llm";
import { buildContext, ContextGroups, SelfPathReader } from "./context";

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
    baseUrl: string;
    model: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  systemPrompt: string;
  context: ContextGroups;
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
            baseUrl: {
              type: "string",
              title: "Base URL",
              description:
                "OpenAI-compatible endpoint. LM Studio: http://<windows-ip>:1234/v1 · Ollama: http://<host>:11434/v1",
              default: "http://192.168.0.50:1234/v1",
            },
            model: {
              type: "string",
              title: "Model",
              description:
                "Model id as loaded in the server (LM Studio shows it at the top). E.g. qwen2.5-7b-instruct",
              default: "qwen2.5-7b-instruct",
            },
            apiKey: {
              type: "string",
              title: "API key",
              description: "Usually empty for local servers (LM Studio/Ollama).",
              default: "",
            },
            temperature: {
              type: "number",
              title: "Temperature",
              default: 0.4,
            },
            maxTokens: {
              type: "number",
              title: "Max reply tokens",
              default: 200,
            },
            timeoutMs: {
              type: "number",
              title: "Request timeout (ms)",
              default: 30000,
            },
          },
        },
        systemPrompt: {
          type: "string",
          title: "System prompt",
          description: "How the assistant should behave. Keep replies short — they are spoken.",
          default: DEFAULT_SYSTEM_PROMPT,
        },
        context: {
          type: "object",
          title: "Boat data the assistant can use",
          properties: {
            navigation: { type: "boolean", title: "Navigation (position, speed, course, depth)", default: true },
            anchor: { type: "boolean", title: "Anchor (state, radius, drag)", default: true },
            environment: { type: "boolean", title: "Environment / wind", default: true },
            electrical: { type: "boolean", title: "Electrical / tanks", default: true },
          },
        },
        replyTargetOriginOnly: {
          type: "boolean",
          title: "Reply only to the satellite that asked",
          description: "If off, the answer plays on all satellites.",
          default: true,
        },
        speakErrors: {
          type: "boolean",
          title: "Speak errors aloud",
          description: "If the LLM is unreachable, say a short spoken error instead of staying silent.",
          default: true,
        },
      },
    }),

    start(config: Config) {
      running = true;
      // Diagnostic surfaced via status (readable over the API without the
      // plugin debug flag): reflects whether the say() handle was acquired.
      let sayAcquired = false;
      const refreshStatus = () => {
        app.setPluginStatus?.(
          `${sayAcquired ? "say() ready" : "waiting for signalk-wyoming say()"} — LLM ${config.llm.baseUrl} (${config.llm.model})`,
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
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
          apiKey: config.llm.apiKey || undefined,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          timeoutMs: config.llm.timeoutMs,
        };

        const boat = buildContext(reader, config.context);
        const system =
          (config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
          (boat ? `\n\nCurrent boat data:\n${boat}` : "");
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
          subscribe: [
            { path: "voice.command", policy: "instant" },
          ],
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
        app.error("subscriptionmanager unavailable — cannot read voice.command");
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
