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
  - **Anchor** — anchored?, current vs. watch radius, *drag* detection
  - **Environment** — apparent/true wind, water/air temperature, pressure
  - **Electrical / tanks** — battery SOC/voltage, fuel + water levels
- **Speaks the reply** via signalk-wyoming's `say()`, defaulting to the
  satellite that asked. Answers are prompted to be short (they are read aloud).
- **STT-robust** — the system prompt tells the model the text came from
  speech-to-text and may be misheard, so it interprets nautically
  (e.g. "debt" → "depth").

## Requirements

- **signalk-wyoming** running (provides `voice.command` + the `say()` API).
- An **OpenAI-compatible** chat endpoint. Examples:
  - **LM Studio** — Developer → Start Server; `http://<host>:1234/v1`
  - **Ollama** — `http://<host>:11434/v1`
  - **llama.cpp server**, or any compatible gateway.

## Configure

In the plugin config:

| Field | Notes |
|-------|-------|
| `llm.baseUrl` | e.g. `http://192.168.0.50:1234/v1` |
| `llm.model` | model id as the server reports it (e.g. `qwen2.5-7b-instruct`) |
| `llm.apiKey` | usually empty for local servers |
| `llm.temperature` / `maxTokens` / `timeoutMs` | generation + request tuning |
| `systemPrompt` | how the assistant behaves (kept short — replies are spoken) |
| `context.*` | which boat-data groups to feed the LLM |
| `replyTargetOriginOnly` | reply only to the satellite that asked (else all) |
| `speakErrors` | speak a short error if the LLM is unreachable |

## Notes

- The LLM's **first** request after a load/restart is slow (model + CUDA
  warm-up), then fast.
- Recommended small local model that fits ~8 GB VRAM:
  `Qwen2.5-7B-Instruct` (Q4_K_M).

## Roadmap

- Intent/actuation (voice → SignalK PUTs) as a separate concern.
- Conversation memory / follow-ups.

MIT.
