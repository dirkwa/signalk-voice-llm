// Provider preset resolution — pure logic, no network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PROVIDERS, resolveBaseUrl } from "../providers";

test("a remote preset overrides the configured base URL", () => {
  const configured = "http://192.168.0.50:1234/v1";
  assert.equal(
    resolveBaseUrl("groq", configured),
    PROVIDERS.groq.baseUrl,
    "groq must use its fixed host, not the stale local URL",
  );
  assert.equal(
    resolveBaseUrl("cerebras", configured),
    PROVIDERS.cerebras.baseUrl,
  );
  assert.equal(
    resolveBaseUrl("openrouter", configured),
    PROVIDERS.openrouter.baseUrl,
  );
});

test("local and custom defer to the configured base URL", () => {
  const configured = "http://boat.local:8080/v1";
  assert.equal(resolveBaseUrl("local", configured), configured);
  assert.equal(resolveBaseUrl("custom", configured), configured);
});

test("an unknown/absent provider falls back to the configured URL", () => {
  // A config that predates the provider field carries no provider — the plugin
  // treats it as local, and resolveBaseUrl must not blow up on the missing key.
  const configured = "http://legacy.local/v1";
  assert.equal(resolveBaseUrl(undefined, configured), configured);
  assert.equal(resolveBaseUrl("", configured), configured);
  assert.equal(resolveBaseUrl("nonsense", configured), configured);
});
