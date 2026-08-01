// Provider presets for the OpenAI-compatible chat endpoint.
//
// Every provider here speaks the same POST /v1/chat/completions protocol the
// llm.ts client already uses, so switching between them is purely a matter of
// base URL, API key and model id — no per-provider code. A preset just fills in
// the base URL (and documents a sensible default model) so the skipper picks a
// provider from a dropdown instead of remembering hostnames.
//
// `local` and `custom` both defer to the operator-supplied base URL: `local`
// for an on-boat server (LM Studio / Ollama), `custom` for anything else that
// is OpenAI-compatible but not in this table. The remote presets are free-tier
// hosted models — fast enough for voice and far more capable than a small local
// model, at the cost of needing internet and sending the query off the boat.

export type ProviderId =
  "local" | "groq" | "cerebras" | "openrouter" | "custom";

export interface ProviderPreset {
  // Human label for the config dropdown.
  label: string;
  // Fixed OpenAI-compatible base URL, or null when the operator supplies it
  // (local / custom read the configured baseUrl verbatim).
  baseUrl: string | null;
  // A reasonable default model id to show in the description; not enforced.
  suggestedModel: string;
  // Whether this provider leaves the boat (drives the UI hint only).
  remote: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  local: {
    label: "Local (LM Studio / Ollama)",
    baseUrl: null,
    suggestedModel: "qwen2.5-7b-instruct",
    remote: false,
  },
  groq: {
    label: "Groq (fast, free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    suggestedModel: "llama-3.3-70b-versatile",
    remote: true,
  },
  cerebras: {
    label: "Cerebras (fast, free tier)",
    baseUrl: "https://api.cerebras.ai/v1",
    suggestedModel: "llama-3.3-70b",
    remote: true,
  },
  openrouter: {
    label: "OpenRouter (many models, free tier)",
    baseUrl: "https://openrouter.ai/api/v1",
    suggestedModel: "meta-llama/llama-3.3-70b-instruct:free",
    remote: true,
  },
  custom: {
    label: "Custom (any OpenAI-compatible URL)",
    baseUrl: null,
    suggestedModel: "",
    remote: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PROVIDERS;
}

/**
 * Resolve the effective base URL for a provider + configured base URL.
 *
 * A remote preset's fixed URL wins so the operator can't accidentally point
 * "groq" at a stale local address. `local`/`custom` (and any unknown value,
 * defensively) fall back to the configured base URL — which is also what an
 * existing config that predates the provider field carries, so those users
 * keep working unchanged.
 */
export function resolveBaseUrl(
  provider: unknown,
  configuredBaseUrl: string,
): string {
  if (isProviderId(provider)) {
    const preset = PROVIDERS[provider].baseUrl;
    if (preset) return preset;
  }
  return configuredBaseUrl;
}
