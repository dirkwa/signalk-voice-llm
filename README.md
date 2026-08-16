# signalk-voice-llm

Answer a boat's spoken voice commands with a local or remote LLM.

This SignalK plugin closes the loop on the [signalk-wyoming](https://github.com/hoeken/signalk-wyoming)
voice family: it subscribes to the `voice.command` path (published when a
Wyoming satellite transcribes speech), asks an **OpenAI-compatible** LLM, and
speaks the reply back through `say()`. It answers questions about the vessel
from live boat data _and_ ranges freely over sailing, destinations, geography,
and general knowledge. Fully offline if you run the LLM locally.

```
you speak  →  voice.command (SignalK)
           →  signalk-voice-llm  →  LLM (LM Studio / Ollama / llama.cpp / …)
           →  say({ targets: [satellite] })  →  the boat speaks the answer
```

## What it does

- **Subscribes to `voice.command`** and, for each utterance, asks the LLM.
- **Answers anything, not just boat status** — the default prompt makes it a
  knowledgeable companion: ask about the depth or the anchor, but also about a
  passage to Fiji, what Kiribati is like, or how to cook fish aboard. It uses
  live boat data when the question is about the vessel and speaks a natural,
  spoken-length reply (short for simple questions, a paragraph when warranted).
- **Gives the LLM live boat context** — a compact, unit-friendly snapshot of
  the vessel so it can answer questions about it. Selectable groups:
  - **Navigation** — position, speed over ground, course, heading, depth
  - **Anchor** — anchored?, current vs. watch radius, _drag_ detection
  - **Environment** — apparent/true wind, water/air temperature, pressure
  - **Electrical / tanks** — battery SOC/voltage, fuel + water levels
- **Adds live weather + sea state** for the boat's position from the **SignalK
  Weather API** — so the assistant can answer "what's the wind doing tonight?"
  even when the LLM has no internet. Current conditions plus a short forecast
  trend (wind, gusts, temperature) and **sea state** (wave height/period, swell)
  are summarised into the context. The data comes from whatever weather-provider
  plugin you have installed (e.g.
  [@signalk/open-meteo-provider](https://www.npmjs.com/package/@signalk/open-meteo-provider)) —
  this plugin owns no API keys or hosts. **Tides** (next high/low water) come
  from a tides plugin (e.g.
  [signalk-tides](https://www.npmjs.com/package/signalk-tides)) via
  `environment.tide.*`. Best-effort: if no provider is installed, the weather
  block is simply omitted.
- **Speaks the reply** via signalk-wyoming's `say()`, defaulting to the
  satellite that asked. The prompt keeps replies **speakable** — plain prose,
  no markdown or lists — since they are read aloud by text-to-speech.
- **STT-robust** — the system prompt tells the model the text came from
  speech-to-text and may be misheard, so it interprets nautically
  (e.g. "debt" → "depth").
- **Knows the local time** — SignalK publishes only UTC, so when a timezone
  plugin (e.g.
  [@yachteye/signalk-timezone-plugin](https://www.npmjs.com/package/@yachteye/signalk-timezone-plugin))
  supplies the boat's local time, the assistant includes it in the context and
  can reason about "now", "tonight", and when the next tide is. Without such a
  plugin, the time line is simply omitted.
- **Can call tools (MCP)** — optionally, the assistant can act on the boat's
  behalf by calling tools on [MCP](https://modelcontextprotocol.io/) servers you
  configure. The first target is
  [fsk-mcp](https://github.com/SignalK/freeboard-sk/tree/master/dev-tools/fsk-mcp),
  which drives the Freeboard-SK chart plotter — "center the chart on the marina",
  "zoom to my active route", "find anchorages near me". Tools are **off by
  default** and only ever act when you enable them and list a server. **Tool
  calling needs a capable model** — small local models (e.g. Qwen2.5-7B) are
  unreliable at emitting tool calls, so use a hosted model (Groq/Cerebras 70B) or
  a tool-tuned local model when you turn this on. See _Tools (MCP)_ below.

## Requirements

- **[signalk-wyoming](https://www.npmjs.com/package/signalk-wyoming)** running —
  it provides both halves this plugin depends on: the `voice.command` path and
  the `say()` API. Install it from the Signal K App Store (it is declared as a
  `requires` dependency, so the App Store will flag it if missing).
- An **OpenAI-compatible** chat endpoint. Pick a **provider** in the config:
  - **Local** — an on-boat server: **LM Studio** (Developer → Start Server;
    `http://<host>:1234/v1`), **Ollama** (`http://<host>:11434/v1`),
    llama.cpp, or any compatible gateway. Private and works offline.
  - **Groq / Cerebras / OpenRouter** — hosted models with a free tier available,
    fast enough for voice and far more capable than a small local model (larger
    models may bill per token). These need internet and an API key (create one in
    the provider's console), and the question plus the boat snapshot leave the
    boat. A hosted provider is the way to discuss weather, routes and sailing
    destinations with a strong model.
  - **Custom** — any other OpenAI-compatible URL.
- **Optional, for weather, tides & local time** — install a SignalK
  **weather-provider** plugin (recommended:
  [@signalk/open-meteo-provider](https://www.npmjs.com/package/@signalk/open-meteo-provider),
  free, no key), a **tides** plugin
  ([signalk-tides](https://www.npmjs.com/package/signalk-tides)), and a
  **timezone** plugin
  ([@yachteye/signalk-timezone-plugin](https://www.npmjs.com/package/@yachteye/signalk-timezone-plugin),
  so the assistant knows the boat's local time). Without them, the
  weather/tide/time lines are simply skipped. All three are listed under
  `signalk.recommends`, so the App Store suggests them.

## Configure

In the plugin config:

| Field                                                            | Notes                                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `llm.provider`                                                   | `local`, `groq`, `cerebras`, `openrouter`, or `custom`                                                                  |
| `llm.baseUrl`                                                    | used by `local`/`custom` (a hosted provider overrides it)                                                               |
| `llm.model`                                                      | model id for the provider (e.g. `qwen2.5-7b-instruct`, `llama-3.3-70b-versatile`)                                       |
| `llm.apiKey`                                                     | empty for local; required for a hosted provider                                                                         |
| `llm.temperature` / `maxTokens` / `timeoutMs`                    | generation + request tuning                                                                                             |
| `systemPrompt`                                                   | how the assistant behaves (open-topic by default; edit to make it terser or boat-only — keep it speakable, no markdown) |
| `context.*`                                                      | which boat-data groups to feed the LLM                                                                                  |
| `weather.enabled`                                                | add weather + sea state from the SignalK Weather API (needs a weather-provider plugin)                                  |
| `weather.forecastHours`                                          | how many forecast intervals ahead to summarise (1–48)                                                                   |
| `weather.marine`                                                 | also include sea state (waves + swell) when the provider supplies it                                                    |
| `tools.enabled`                                                  | let the model call MCP tools (off by default — see _Tools (MCP)_)                                                       |
| `tools.mcpServers`                                               | the MCP servers to expose as tools (`name` + `url`, optional `token`)                                                   |
| `tools.maxIterations` / `conversationBudgetMs` / `callTimeoutMs` | bound how long a tool conversation may run                                                                              |
| `replyTargetOriginOnly`                                          | reply only to the satellite that asked (else all)                                                                       |
| `speakErrors`                                                    | speak a short error if the LLM is unreachable                                                                           |

## Tools (MCP)

The assistant can optionally call tools on
[MCP](https://modelcontextprotocol.io/) servers you configure, so it can _act_,
not just answer — for example drive the chart plotter. It is a generic MCP
client: it connects to each server, discovers its tools, and offers them to the
model; any Streamable-HTTP MCP server works, not just the one below.

To enable:

1. Set `tools.enabled` on.
2. Add a server under `tools.mcpServers`, e.g. `name: fsk`,
   `url: http://127.0.0.1:3013/mcp`.
3. Point the plugin at a **capable model** (see the caveat below).

**First target — fsk-mcp (Freeboard-SK).**
[fsk-mcp](https://github.com/SignalK/freeboard-sk/tree/master/dev-tools/fsk-mcp)
exposes the Freeboard-SK plotter as MCP tools (set the map view, list/inspect
routes, query resources, filters). With it configured you can say "center the
chart on the marina" or "zoom to my active route". Note that fsk-mcp is a
**development tool**: it relays each call to a **live Freeboard-SK browser tab**,
so a tab must be open for the tools to answer, and it is not meant for an
unattended production server. Getting it onto a boat cleanly (no dev-only
plugin, no browser tab required) is tracked upstream in Freeboard-SK.

> **A capable model is required.** Tool calling asks the model to emit
> structured `tool_calls`. Small local models (e.g. Qwen2.5-7B) do this
> unreliably or not at all, so with tools on, prefer a hosted model
> (Groq/Cerebras 70B) or a tool-tuned local model. This is why tools are **off
> by default** — enabling them would degrade the common local-model install.

Safety notes for a spoken assistant: replies stay speakable (the model is told
tool results are data, not text to read aloud), and every tool round trip is
bounded by `maxIterations` and `conversationBudgetMs` so a reply can't run away.
Whatever tools a configured server exposes are available to the model once
enabled — including any that change boat state — so only add servers you trust.

## Notes

- **Local vs hosted.** A local model is private and works offline but is
  smaller; a hosted provider is far more capable for open-ended questions
  (destinations, geography) at the cost of internet and some latency. Free
  hosted tiers can rate-limit under load — if a reply fails, retry or switch
  models. The question and boat snapshot leave the boat only for hosted
  providers.
- The LLM's **first** request after a load/restart is slow (model + CUDA
  warm-up), then fast.
- Recommended small local model that fits ~8 GB VRAM:
  `Qwen2.5-7B-Instruct` (Q4_K_M).
- `maxTokens` bounds reply length (default 500 — room for a spoken paragraph);
  lower it for terser, faster replies.

## Roadmap

- Intent/actuation (voice → SignalK PUTs) as a separate concern.
- Conversation memory / follow-ups.

## License

signalk-voice-llm 0.5.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in education and research; and provide professional services around it.

**You may not**: redistribute it, or publish a modified version of it to npm or
anywhere else. Verbatim copies of official releases may be mirrored and cached.

Versions 0.4.0 and earlier remain available under the Apache License 2.0 — see
[LICENSE-APACHE-2.0-through-v0.4.0.txt](LICENSE-APACHE-2.0-through-v0.4.0.txt).
