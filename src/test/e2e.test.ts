// End-to-end: voice.command -> boat context -> LLM -> say().
//
// These drive the real plugin module against a real HTTP LLM stub. They cover
// the happy path and, deliberately, every failure this plugin has actually
// shipped or nearly shipped: the partial-config crash, the discarded
// AbortError, and the reply that arrives after the plugin was stopped.

// Tide/forecast times are rendered in the server's local timezone; pin it to
// UTC so the HH:MM assertions are deterministic regardless of the CI machine's
// zone. Must be set before the plugin module is require()d below.
process.env.TZ = "UTC";

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { createMockApp, settle, startFakeLlm, waitFor } from "./harness";
import { PROVIDERS, resolveBaseUrl } from "../providers";

// require() rather than import: the plugin is CommonJS
// (module.exports = function (app) {…}), which is the shape Signal K loads.
// A fresh require per test would be pointless — the module holds no state
// outside the factory — but the factory itself must be called per test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginFactory = require(path.join(__dirname, "..", "index.js")) as (
  app: unknown,
) => {
  start(config: unknown): void;
  stop(): void;
  schema(): unknown;
  id: string;
  name: string;
};

function configFor(baseUrl: string, over: Record<string, unknown> = {}) {
  return {
    llm: {
      baseUrl,
      model: "test-model",
      apiKey: "",
      temperature: 0.4,
      maxTokens: 200,
      timeoutMs: 5000,
    },
    ...over,
  };
}

test("speaks the LLM reply back to the satellite that asked", async () => {
  const llm = await startFakeLlm("Depth is 4.2 metres.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("what is my depth", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no reply was ever spoken");

  assert.equal(llm.requests.length, 1, "should have asked the LLM once");
  assert.deepEqual(mock.spoken, [
    { text: "Depth is 4.2 metres.", targets: ["cockpit"] },
  ]);

  // The user's words must reach the model verbatim.
  const sent = llm.requests[0]!;
  assert.equal(sent.model, "test-model");
  const user = sent.messages.find((m) => m.role === "user");
  assert.equal(user?.content, "what is my depth");

  plugin.stop();
  await llm.close();
});

test("default system prompt is open-topic yet keeps replies speakable", async () => {
  const llm = await startFakeLlm("Kiribati is a Pacific island nation…");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl)); // default systemPrompt
  mock.provideSay();
  mock.sendCommand("tell me about kiribati", "cockpit");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.ok(system, "a system message should be present");
  // Not restricted to the boat — general questions are explicitly allowed.
  assert.match(system.content, /not restricted to boat topics/i);
  assert.match(system.content, /destinations|geography|general knowledge/i);
  // Still speakable: markup must be forbidden (TTS reads it aloud).
  assert.match(system.content, /no markdown/i);
  // The STT-lossy framing is retained.
  assert.match(system.content, /misheard|transcribed from speech/i);

  plugin.stop();
  await llm.close();
});

test("feeds converted boat data to the model, not raw SI", async () => {
  const llm = await startFakeLlm("Ok.");
  const mock = createMockApp();

  // Signal K is SI internally. These are the units the plugin must convert.
  mock.selfPaths["navigation.speedOverGround"] = 5.144; // m/s -> ~10 kn
  mock.selfPaths["navigation.headingTrue"] = Math.PI; // rad -> 180°
  mock.selfPaths["environment.water.temperature"] = 288.15; // K -> 15°C
  mock.selfPaths["environment.outside.pressure"] = 101300; // Pa -> 1013 hPa
  mock.selfPaths["environment.depth.belowKeel"] = 4.2;

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("status");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.ok(system, "a system message should carry the boat context");
  const ctx = system.content;

  assert.match(ctx, /speed over ground 10 kn/, "m/s must become knots");
  assert.match(ctx, /heading 180°/, "radians must become degrees");
  assert.match(ctx, /water 15°C/, "kelvin must become celsius");
  assert.match(ctx, /pressure 1013 hPa/, "pascals must become hPa");
  assert.match(ctx, /depth 4.2 m/);

  // Absent paths must not leak placeholders into the prompt.
  assert.doesNotMatch(ctx, /undefined|NaN|null/);

  plugin.stop();
  await llm.close();
});

test("start() survives a partial config (the 0.2.0 crash)", async () => {
  const llm = await startFakeLlm("Fine.");

  // 0.2.0 threw "Cannot read properties of undefined (reading 'baseUrl')"
  // here: Signal K passes {} on first enable, before anything is saved.
  for (const cfg of [{}, undefined, { llm: { model: "only-model" } }]) {
    const mock = createMockApp();
    const plugin = pluginFactory(mock.app);
    assert.doesNotThrow(
      () => plugin.start(cfg),
      `start(${JSON.stringify(cfg)}) must not throw`,
    );
    plugin.stop();
  }

  // A partial llm block keeps the user's field and fills the rest, rather
  // than leaving baseUrl undefined.
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);
  plugin.start({ llm: { baseUrl: llm.baseUrl, model: "kept" } });
  mock.provideSay();
  mock.sendCommand("hi");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  assert.equal(
    llm.requests.length,
    1,
    "the merged config must still be usable",
  );
  assert.equal(llm.requests[0]!.model, "kept", "user's value must survive");
  assert.equal(
    llm.requests[0]!.max_tokens,
    500,
    "missing field must come from defaults",
  );

  plugin.stop();
  await llm.close();
});

test("does not speak a reply that arrives after stop()", async () => {
  const llm = await startFakeLlm("Too late.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("slow question");

  // Stop while the request is still in flight — the user disabled the plugin
  // mid-question. Speaking now would talk into a boat whose owner just
  // switched the assistant off.
  plugin.stop();

  // Wait for the request to actually reach the stub before judging the
  // silence, otherwise this passes for the wrong reason on a slow runner:
  // nothing spoken merely because nothing had happened yet.
  await waitFor(
    () => llm.requests.length === 1,
    "the request should still have gone out before stop() took effect",
  );
  await settle();

  assert.deepEqual(mock.spoken, [], "nothing may be spoken after stop()");

  await llm.close();
});

test("speaks an error when the LLM is unreachable", async () => {
  const llm = await startFakeLlm();
  llm.setStatus(500, "boom");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl, { speakErrors: true }));
  mock.provideSay();
  mock.sendCommand("anything", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no spoken error");

  assert.equal(
    mock.spoken.length,
    1,
    "the skipper must not be left in silence",
  );
  assert.match(mock.spoken[0]!.text, /sorry/i);
  assert.deepEqual(mock.spoken[0]!.targets, ["cockpit"]);
  assert.ok(
    mock.pluginErrorLog.some((m) => /500/.test(m)),
    "and the failure must be visible in the plugin status",
  );

  plugin.stop();
  await llm.close();
});

test("stays silent on LLM failure when speakErrors is off", async () => {
  const llm = await startFakeLlm();
  llm.setStatus(500, "boom");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl, { speakErrors: false }));
  mock.provideSay();
  mock.sendCommand("anything");
  await waitFor(
    () => mock.errorLog.some((m) => /LLM failed/.test(m)),
    "the LLM failure was never logged",
  );
  await settle();

  assert.deepEqual(mock.spoken, []);
  assert.ok(mock.errorLog.some((m) => /LLM failed/.test(m)));

  plugin.stop();
  await llm.close();
});

test("a timed-out request reports the timeout and keeps the cause", async () => {
  const llm = await startFakeLlm();
  llm.setHang(true);
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  // A short timeout so the test doesn't sit through the 30s default.
  plugin.start({
    llm: {
      baseUrl: llm.baseUrl,
      model: "test-model",
      apiKey: "",
      temperature: 0.4,
      maxTokens: 200,
      timeoutMs: 250,
    },
    speakErrors: false,
  });
  mock.provideSay();
  mock.sendCommand("will hang");
  await waitFor(
    () => mock.errorLog.some((m) => /timed out/.test(m)),
    "the timeout was never reported",
  );

  assert.ok(
    mock.errorLog.some((m) => /timed out after 250 ms/.test(m)),
    `expected a timeout error, got: ${JSON.stringify(mock.errorLog)}`,
  );

  plugin.stop();
  await llm.close();
});

test("replies to all satellites when replyTargetOriginOnly is off", async () => {
  const llm = await startFakeLlm("Broadcast.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl, { replyTargetOriginOnly: false }));
  mock.provideSay();
  mock.sendCommand("tell everyone", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no reply was spoken");

  assert.equal(mock.spoken.length, 1);
  assert.equal(
    mock.spoken[0]!.targets,
    undefined,
    "no targets means signalk-wyoming plays it everywhere",
  );

  plugin.stop();
  await llm.close();
});

test("survives a missing say() handle without throwing", async () => {
  const llm = await startFakeLlm("Nobody hears this.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  // signalk-wyoming never published its API — not installed, or not started.
  plugin.start(configFor(llm.baseUrl));
  mock.sendCommand("hello");
  await waitFor(
    () => mock.errorLog.some((m) => /no say\(\) handle/.test(m)),
    "the missing handle was never reported",
  );

  assert.deepEqual(mock.spoken, []);
  assert.ok(
    mock.errorLog.some((m) => /no say\(\) handle/.test(m)),
    "the operator needs to be told why nothing was spoken",
  );

  plugin.stop();
  await llm.close();
});

test("finds say() when newer PropertyValues entries lack it", async () => {
  const llm = await startFakeLlm("Found it anyway.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl));
  // wyoming re-emits its API without a say handle — the newest entries are
  // sayless, so the plugin must walk backwards to the one that has it.
  // Reading only the last entry (or only history[0]) would strand the plugin
  // with no way to speak.
  mock.provideSay({ sayless: 2 });
  mock.sendCommand("still there?");
  await waitFor(
    () => mock.spoken.length > 0,
    "the backward walk failed to find the say handle",
  );

  assert.equal(mock.spoken[0]!.text, "Found it anyway.");

  plugin.stop();
  await llm.close();
});

test("keeps the say() handle across a stop()/start() cycle", async () => {
  const llm = await startFakeLlm("Still working.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  plugin.stop();

  // A config change restarts the plugin, but PropertyValues does not reliably
  // re-deliver wyoming's history. Dropping the handle here would silently
  // break replies until wyoming itself restarted.
  plugin.start(configFor(llm.baseUrl));
  mock.sendCommand("after a config change");
  await waitFor(() => mock.spoken.length > 0, "reply lost after restart");

  assert.equal(
    mock.spoken.length,
    1,
    "voice replies must survive a config change",
  );

  plugin.stop();
  await llm.close();
});

test("a rejecting say() is caught, not thrown at the server", async () => {
  const llm = await startFakeLlm("Try to say this.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  mock.failSayWith(new Error("wyoming is stopped"));
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("hello");
  await waitFor(
    () => mock.errorLog.some((m) => /say\(\) failed/.test(m)),
    "the say() rejection was never logged",
  );

  assert.ok(
    mock.errorLog.some((m) => /say\(\) failed/.test(m)),
    "the rejection must be logged, and must not escape the plugin",
  );

  plugin.stop();
  await llm.close();
});

test("missing subscriptionmanager is reported, not fatal", async () => {
  const llm = await startFakeLlm();
  const mock = createMockApp({ withSubscriptionManager: false });
  const plugin = pluginFactory(mock.app);

  assert.doesNotThrow(() => plugin.start(configFor(llm.baseUrl)));
  assert.ok(
    mock.errorLog.some((m) => /subscriptionmanager unavailable/.test(m)),
  );

  plugin.stop();
  await llm.close();
});

test("missing onPropertyValues is reported, not fatal", async () => {
  const llm = await startFakeLlm();
  const mock = createMockApp({ withPropertyValues: false });
  const plugin = pluginFactory(mock.app);

  assert.doesNotThrow(() => plugin.start(configFor(llm.baseUrl)));
  assert.ok(mock.errorLog.some((m) => /onPropertyValues unavailable/.test(m)));

  plugin.stop();
  await llm.close();
});

test("sends an Authorization header only when an apiKey is set", async () => {
  const llm = await startFakeLlm("Ok.");
  const mock = createMockApp();

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl)); // apiKey: ""
  mock.provideSay();
  mock.sendCommand("no key");
  await waitFor(() => llm.requests.length > 0, "no request sent");
  assert.equal(
    llm.requests[0]!.authorization,
    undefined,
    "local servers must not get a bogus empty bearer token",
  );
  plugin.stop();

  const mock2 = createMockApp();
  const plugin2 = pluginFactory(mock2.app);
  plugin2.start({
    llm: {
      baseUrl: llm.baseUrl,
      model: "test-model",
      apiKey: "secret-key",
      temperature: 0.4,
      maxTokens: 200,
      timeoutMs: 5000,
    },
  });
  mock2.provideSay();
  mock2.sendCommand("with key");
  await waitFor(() => llm.requests.length > 1, "second request never sent");
  assert.equal(llm.requests[1]!.authorization, "Bearer secret-key");

  // The key must never reach a log line.
  const allLogs = [
    ...mock2.debugLog,
    ...mock2.errorLog,
    ...mock2.statusLog,
    ...mock2.pluginErrorLog,
  ].join("\n");
  assert.doesNotMatch(
    allLogs,
    /secret-key/,
    "the api key must never be logged",
  );

  plugin2.stop();
  await llm.close();
});

test("ignores empty and whitespace-only commands", async () => {
  const llm = await startFakeLlm("Should not be asked.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("");
  mock.sendCommand("   ");
  await settle();

  assert.equal(llm.requests.length, 0, "silence must not wake the LLM");
  assert.deepEqual(mock.spoken, []);

  plugin.stop();
  await llm.close();
});

test("exposes a config schema that matches the runtime defaults", async () => {
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  assert.equal(plugin.id, "signalk-voice-llm");
  const schema = plugin.schema() as {
    properties: Record<
      string,
      { properties?: Record<string, { default?: unknown }>; default?: unknown }
    >;
  };

  // The schema defaults are the source the merge reads from, so a drift here
  // is what caused the 0.2.0 crash to be invisible until runtime.
  assert.equal(schema.properties.llm!.properties!.maxTokens!.default, 500);
  assert.equal(schema.properties.llm!.properties!.timeoutMs!.default, 30000);
  assert.equal(schema.properties.replyTargetOriginOnly!.default, true);
  assert.equal(schema.properties.speakErrors!.default, true);
});

// SI-unit sample forecast for the weather-API tests (K, Pa, m/s, rad).
const WX_SAMPLE = [
  {
    date: "2026-08-02T05:00:00.000Z",
    description: "Partly cloudy",
    outside: { temperature: 288.15, pressure: 101300 },
    wind: {
      speedTrue: 10.29,
      directionTrue: (225 * Math.PI) / 180,
      gust: 12.86,
    },
    water: {
      waveSignificantHeight: 1.2,
      wavePeriod: 5.5,
      waveDirection: (300 * Math.PI) / 180,
      swellHeight: 0.8,
      swellPeriod: 7.2,
    },
  },
  {
    date: "2026-08-02T09:00:00.000Z",
    outside: { temperature: 290.15 },
    wind: {
      speedTrue: 12.86,
      directionTrue: (250 * Math.PI) / 180,
      gust: 15.43,
    },
  },
];

test("feeds weather + sea state from the SignalK Weather API to the model", async () => {
  const llm = await startFakeLlm("Fresh breeze this afternoon.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: 54.32, longitude: 10.14 },
  };
  mock.setWeather(WX_SAMPLE);

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("what's the wind doing this afternoon", "cockpit");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.ok(system, "a system message should carry the forecast");
  assert.match(system.content, /Weather and sea conditions/i);
  assert.match(system.content, /Now: Partly cloudy, 15°C, wind SW 20 kn/);
  assert.match(system.content, /gusting/, "hourly gusts summarised");
  assert.match(system.content, /Sea state: waves 1\.2 m from WNW/);
  assert.match(system.content, /swell 0\.8 m/);
  // No raw SI units or placeholders leak in.
  assert.doesNotMatch(system.content, /undefined|NaN|101300|288\.15/);

  plugin.stop();
  await llm.close();
});

test("feeds tide extremes from environment.tide to the model", async () => {
  const llm = await startFakeLlm("Tide's turning.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: -17.6, longitude: 177.4 },
  };
  mock.selfPaths["environment.tide.state"] = "rising";
  mock.selfPaths["environment.tide.heightNow"] = 1.08;
  mock.selfPaths["environment.tide.timeHigh"] = "2026-08-02T08:55:00.000Z";
  mock.selfPaths["environment.tide.heightHigh"] = 1.78;
  mock.selfPaths["environment.tide.timeLow"] = "2026-08-02T14:56:00.000Z";
  mock.selfPaths["environment.tide.heightLow"] = 0.59;

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("when's high water", "cockpit");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.match(system!.content, /Tide: 1\.1 m and rising/);
  assert.match(system!.content, /next high water 08:55/);
  assert.match(system!.content, /next low water 14:56/);

  plugin.stop();
  await llm.close();
});

test("skips weather when disabled", async () => {
  const llm = await startFakeLlm("Ok.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: 54.32, longitude: 10.14 },
  };
  mock.setWeather(WX_SAMPLE);

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl, { weather: { enabled: false } }));
  mock.provideSay();
  mock.sendCommand("weather?");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  assert.equal(
    mock.weatherCalls.length,
    0,
    "must not call the weather API when disabled",
  );
  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.doesNotMatch(system!.content, /Weather and sea conditions/i);

  plugin.stop();
  await llm.close();
});

test("uses default forecastHours/marine when weather config is partial", async () => {
  // A config with only { enabled: true } must still fetch — the nested merge
  // fills forecastHours (12) and marine (true) from the defaults.
  const llm = await startFakeLlm("Breezy.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: 54.32, longitude: 10.14 },
  };
  mock.setWeather(WX_SAMPLE);

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl, { weather: { enabled: true } }));
  mock.provideSay();
  mock.sendCommand("weather?", "cockpit");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  assert.equal(mock.weatherCalls.length, 1);
  const [pos, type, opts] = mock.weatherCalls[0]!;
  assert.deepEqual(pos, { latitude: 54.32, longitude: 10.14 });
  assert.equal(type, "point");
  assert.deepEqual(opts, { maxCount: 12 }, "default forecastHours");
  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.match(system!.content, /Sea state/, "default marine=true summarised");

  plugin.stop();
  await llm.close();
});

test("still answers when no weather provider is registered", async () => {
  const llm = await startFakeLlm("Answering anyway.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: 54.32, longitude: 10.14 },
  };
  // The provider throws exactly as an unregistered Weather API does.
  mock.setWeather(new Error("No providers registered!"));

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("weather?", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no reply was spoken");

  assert.equal(mock.spoken[0]!.text, "Answering anyway.");
  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.doesNotMatch(system!.content, /Weather and sea conditions/i);
  assert.deepEqual(mock.errorLog, [], "a missing provider is not an error");

  plugin.stop();
  await llm.close();
});

test("answers normally when app.weatherApi is absent entirely", async () => {
  const llm = await startFakeLlm("No weather here.");
  const mock = createMockApp();
  mock.selfPaths["navigation.position"] = {
    value: { latitude: 54.32, longitude: 10.14 },
  };
  // Do NOT call setWeather -> app.weatherApi is undefined.

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("weather?", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no reply was spoken");

  assert.equal(mock.spoken[0]!.text, "No weather here.");
  const system = llm.requests[0]!.messages.find((m) => m.role === "system");
  assert.doesNotMatch(system!.content, /Weather and sea conditions/i);
  assert.deepEqual(mock.errorLog, []);

  plugin.stop();
  await llm.close();
});

test("skips weather when the boat has no position", async () => {
  const llm = await startFakeLlm("No fix.");
  const mock = createMockApp(); // no navigation.position set
  mock.setWeather(WX_SAMPLE);

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("weather?");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  assert.equal(mock.weatherCalls.length, 0, "no position -> no weather call");

  plugin.stop();
  await llm.close();
});

test("survives a non-object navigation.position without throwing", async () => {
  const llm = await startFakeLlm("Still answering.");
  const mock = createMockApp();
  // A malformed/legacy delta: a truthy primitive, not an object. `"value" in
  // pos` would throw here — and under void onCommand() that's an unhandled
  // rejection, violating "never crash signalk-server".
  mock.selfPaths["navigation.position"] = 42 as unknown;
  mock.setWeather(WX_SAMPLE);

  const plugin = pluginFactory(mock.app);
  plugin.start(configFor(llm.baseUrl));
  mock.provideSay();
  mock.sendCommand("weather?", "cockpit");
  await waitFor(() => mock.spoken.length > 0, "no reply was spoken");

  assert.equal(mock.spoken[0]!.text, "Still answering.");
  assert.deepEqual(mock.errorLog, [], "a bad position is not an error");

  plugin.stop();
  await llm.close();
});

test("custom provider sends to the configured URL; hosted overrides it", async () => {
  // The plugin must send its request to the provider preset's host, not the
  // baseUrl verbatim — so pointing baseUrl at the stub proves the request path
  // (config -> resolveBaseUrl -> chat) reaches the configured host end-to-end.
  // The *override* branch (a hosted preset replacing baseUrl) can't be driven
  // to a stub without a live host, so it is covered by the unit test in
  // providers.test.ts; here we additionally assert, at this boundary, that a
  // hosted selection would NOT resolve to the configured local URL.
  const llm = await startFakeLlm("Via custom.");
  const mock = createMockApp();
  const plugin = pluginFactory(mock.app);

  plugin.start(
    configFor(llm.baseUrl, {
      llm: {
        provider: "custom",
        baseUrl: llm.baseUrl,
        model: "test-model",
        apiKey: "k",
        temperature: 0.4,
        maxTokens: 200,
        timeoutMs: 5000,
      },
    }),
  );
  mock.provideSay();
  mock.sendCommand("hi", "cockpit");
  await waitFor(() => llm.requests.length > 0, "the LLM was never asked");

  assert.equal(mock.spoken[0]!.text, "Via custom.");
  assert.equal(
    llm.requests.length,
    1,
    "custom must send to the configured baseUrl (the stub)",
  );
  // And a hosted provider must resolve AWAY from that same configured URL.
  assert.notEqual(
    resolveBaseUrl("groq", llm.baseUrl),
    llm.baseUrl,
    "a hosted preset must override the configured baseUrl",
  );
  assert.equal(resolveBaseUrl("groq", llm.baseUrl), PROVIDERS.groq.baseUrl);

  plugin.stop();
  await llm.close();
});

test("the network-isolation guard blocks a non-loopback fetch", async () => {
  // The plugin makes no outbound HTTP (the LLM is loopback-stubbed and weather
  // is in-process via app.weatherApi). This guard is the standing net: any
  // accidental real-host fetch introduced later fails loudly instead of
  // silently hitting the internet in CI.
  await assert.rejects(
    () => fetch("https://example.com/anything"),
    /network isolation: blocked fetch to non-loopback host/,
  );
  // Loopback still works (the stubs rely on it).
  const llm = await startFakeLlm("ok");
  const res = await fetch(`${llm.baseUrl}/models`).catch(() => null);
  assert.ok(res, "loopback fetch must not be blocked");
  await llm.close();
});
