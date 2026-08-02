# signalk-voice-llm

Answer a boat's spoken voice commands with a local or remote LLM.

This SignalK plugin closes the loop on the [signalk-wyoming](https://github.com/hoeken/signalk-wyoming)
voice family: it subscribes to the `voice.command` path (published when a
Wyoming satellite transcribes speech), asks an **OpenAI-compatible** LLM for a
short answer, and speaks the reply back through `say()`. Fully offline if you
run the LLM locally.

```
you speak  →  voice.command (SignalK)
           →  signalk-voice-llm  →  LLM (LM Studio / Ollama / llama.cpp / …)
           →  say({ targets: [satellite] })  →  the boat speaks the answer
```

## What it does

- **Subscribes to `voice.command`** and, for each utterance, asks the LLM.
- **Gives the LLM live boat context** — a compact, unit-friendly snapshot of
  the vessel so it can answer questions about it. Selectable groups:
  - **Navigation** — position, speed over ground, course, heading, depth
  - **Anchor** — anchored?, current vs. watch radius, _drag_ detection
  - **Environment** — apparent/true wind, water/air temperature, pressure
  - **Electrical / tanks** — battery SOC/voltage, fuel + water levels
- **Fetches live weather + sea state** for the boat's position
  ([Open-Meteo](https://open-meteo.com), free, no API key) — a local LLM has
  no internet of its own, so this is how it answers "what's the wind doing
  tonight?". The current conditions plus a short forecast trend (wind, gusts,
  rain chance, temperature) are added to the context, along with **sea state**
  (wave height/period and swell) from the Open-Meteo Marine API. **Tides** (next
  high/low water) can be added with a free [WorldTides](https://www.worldtides.info)
  key — off by default, since tides have no keyless source. Best-effort: any
  source that can't be fetched is simply omitted.
- **Speaks the reply** via signalk-wyoming's `say()`, defaulting to the
  satellite that asked. Answers are prompted to be short (they are read aloud).
- **STT-robust** — the system prompt tells the model the text came from
  speech-to-text and may be misheard, so it interprets nautically
  (e.g. "debt" → "depth").

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

## Configure

In the plugin config:

| Field                                                | Notes                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `llm.provider`                                       | `local`, `groq`, `cerebras`, `openrouter`, or `custom`                            |
| `llm.baseUrl`                                        | used by `local`/`custom` (a hosted provider overrides it)                         |
| `llm.model`                                          | model id for the provider (e.g. `qwen2.5-7b-instruct`, `llama-3.3-70b-versatile`) |
| `llm.apiKey`                                         | empty for local; required for a hosted provider                                   |
| `llm.temperature` / `maxTokens` / `timeoutMs`        | generation + request tuning                                                       |
| `systemPrompt`                                       | how the assistant behaves (kept short — replies are spoken)                       |
| `context.*`                                          | which boat-data groups to feed the LLM                                            |
| `weather.enabled`                                    | fetch a live Open-Meteo forecast for the boat's position                          |
| `weather.forecastHours`                              | how far ahead to summarise (1–48)                                                 |
| `weather.marine`                                     | also include sea state (waves + swell) from Open-Meteo Marine                     |
| `weather.tidesApiKey`                                | a free WorldTides key enables next high/low water (blank = off)                   |
| `weather.baseUrl` / `marineBaseUrl` / `tidesBaseUrl` | override hosts for a self-hosted Open-Meteo / WorldTides instance                 |
| `weather.timeoutMs` / `cacheMs`                      | request timeout; reuse window between fetches                                     |
| `replyTargetOriginOnly`                              | reply only to the satellite that asked (else all)                                 |
| `speakErrors`                                        | speak a short error if the LLM is unreachable                                     |

## Notes

- The LLM's **first** request after a load/restart is slow (model + CUDA
  warm-up), then fast.
- Recommended small local model that fits ~8 GB VRAM:
  `Qwen2.5-7B-Instruct` (Q4_K_M).

## Roadmap

- Intent/actuation (voice → SignalK PUTs) as a separate concern.
- Conversation memory / follow-ups.

## License

Apache-2.0 — see [LICENSE](LICENSE).
