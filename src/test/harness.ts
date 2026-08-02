// End-to-end harness: stands up a real HTTP server speaking the
// OpenAI-compatible chat API, plus a mock Signal K `app`, so tests can drive
// the actual plugin module the way the server does — load, start(), feed a
// voice.command delta, observe the spoken reply.
//
// Nothing here stubs the plugin's own code: fetch really goes over TCP and the
// PropertyValues / subscriptionmanager plumbing is exercised as written.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

// --- Network isolation guard --------------------------------------------
//
// The plugin makes no outbound HTTP of its own: the LLM endpoint is a loopback
// stub and weather comes in-process via app.weatherApi. This wraps the global
// fetch so any non-loopback host throws immediately — a standing net that turns
// an accidental real-host call introduced later into a loud failure instead of
// silent CI flakiness that masquerades as a passing test.
//
// Installed as a module side-effect: only e2e.test.ts imports this harness,
// and it is the only test file that makes network calls (to the loopback LLM
// stub), so the guard covers exactly the file that needs it. The pure
// formatter/provider tests never call fetch, so they are unaffected.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  let host = "";
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
    host = parsed.hostname;
  } catch {
    // A malformed URL is itself a test bug — let the real fetch surface it.
  }
  if (host && !LOOPBACK.has(host)) {
    // Log only origin + path — the tides URL carries the WorldTides key as a
    // query param, and printing the full URL would leak it into CI output.
    const safeUrl = parsed ? `${parsed.origin}${parsed.pathname}` : "<invalid>";
    throw new Error(
      `test network isolation: blocked fetch to non-loopback host "${host}" ` +
        `(${safeUrl}). Point it at a loopback stub (e.g. startFakeLlm).`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Fake LLM ------------------------------------------------------------

export interface LlmRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  max_tokens: number;
  authorization?: string;
}

export interface FakeLlm {
  baseUrl: string;
  /** Every request the plugin sent, in order. */
  requests: LlmRequest[];
  /** Replace the reply for subsequent requests. */
  setReply(text: string): void;
  /** Respond with an HTTP error instead of a completion. */
  setStatus(status: number, body?: string): void;
  /** Never respond, so the client's own timeout fires. */
  setHang(hang: boolean): void;
  close(): Promise<void>;
}

export async function startFakeLlm(
  reply = "Depth is 4.2 metres.",
): Promise<FakeLlm> {
  const requests: LlmRequest[] = [];
  let currentReply = reply;
  let status = 200;
  let errorBody = "";
  let hang = false;
  // Held open so a hanging request doesn't keep the server from closing.
  const openResponses = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    // Same reasoning as the unref() below: a hung request must not outlive a
    // failed test.
    req.socket.unref();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        /* leave empty — the assertion in the test will show the raw problem */
      }
      requests.push({
        model: String(parsed.model ?? ""),
        messages: (parsed.messages ?? []) as LlmRequest["messages"],
        temperature: Number(parsed.temperature),
        max_tokens: Number(parsed.max_tokens),
        authorization: req.headers.authorization,
      });

      if (hang) {
        openResponses.add(res);
        return; // deliberately never respond
      }
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(errorBody);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: currentReply } }],
        }),
      );
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  // A failing assertion aborts the test before its close() call, and an open
  // listener would then keep Node's event loop alive forever — turning a test
  // failure into a CI hang, which is strictly worse to diagnose. unref() lets
  // the process exit regardless; close() still runs on the happy path.
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setReply(t) {
      currentReply = t;
    },
    setStatus(s, body = "") {
      status = s;
      errorBody = body;
    },
    setHang(h) {
      hang = h;
    },
    async close() {
      for (const res of openResponses) res.destroy();
      openResponses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// --- Mock Signal K app ---------------------------------------------------

export interface SpokenUtterance {
  text: string;
  targets?: string[];
}

export interface MockApp {
  /** The `app` object handed to the plugin factory. */
  app: Record<string, unknown>;
  /** Everything say() was asked to speak. */
  spoken: SpokenUtterance[];
  debugLog: string[];
  errorLog: string[];
  statusLog: string[];
  pluginErrorLog: string[];
  /** Publish a voice.command, as signalk-wyoming would. */
  sendCommand(text: string, satellite?: string): void;
  /**
   * Emit the signalk-wyoming.api PropertyValue carrying say().
   *
   * `sayless` appends that many entries without a say handle *after* the one
   * that has it, so the plugin has to walk backwards past them. Default 0
   * puts the handle last, which is the common case.
   */
  provideSay(opts?: { sayless?: number }): void;
  /** Make say() reject, as a stopped wyoming would. */
  failSayWith(err: Error): void;
  /** Boat data returned by getSelfPath. */
  selfPaths: Record<string, unknown>;
  /**
   * Install a SignalK Weather API on the app (app.weatherApi.getForecasts).
   * Pass forecast objects to serve, or an Error to make the provider throw
   * (as an unregistered provider does). Not called => app.weatherApi absent.
   */
  setWeather(forecasts: unknown[] | Error): void;
  /** Every getForecasts() call the plugin made, as [position, type, opts]. */
  weatherCalls: unknown[][];
}

export function createMockApp(
  opts: {
    withPropertyValues?: boolean;
    withSubscriptionManager?: boolean;
  } = {},
): MockApp {
  const {
    withPropertyValues: hasPropertyValues = true,
    withSubscriptionManager: hasSubscriptionManager = true,
  } = opts;

  const spoken: SpokenUtterance[] = [];
  const debugLog: string[] = [];
  const errorLog: string[] = [];
  const statusLog: string[] = [];
  const pluginErrorLog: string[] = [];
  const weatherCalls: unknown[][] = [];
  const selfPaths: Record<string, unknown> = {};

  let deltaHandler: ((delta: unknown) => void) | undefined;
  let propertyCb: ((history: unknown[]) => void) | undefined;
  let sayError: Error | undefined;

  const say = async (o: { text: string; targets?: string[] }) => {
    if (sayError) throw sayError;
    spoken.push({ text: o.text, targets: o.targets });
    return { ok: true, queued: o.targets ?? ["all"] };
  };

  const app: Record<string, unknown> = {
    debug: (m: string) => debugLog.push(m),
    error: (m: string) => errorLog.push(m),
    setPluginStatus: (m: string) => statusLog.push(m),
    setPluginError: (m: string) => pluginErrorLog.push(m),
    getSelfPath: (p: string) => selfPaths[p],
  };

  if (hasSubscriptionManager) {
    app.subscriptionmanager = {
      subscribe: (
        _sub: unknown,
        _unsub: unknown[],
        _onError: (e: unknown) => void,
        onDelta: (delta: unknown) => void,
      ) => {
        deltaHandler = onDelta;
      },
    };
  }
  if (hasPropertyValues) {
    app.onPropertyValues = (name: string, cb: (history: unknown[]) => void) => {
      if (name === "signalk-wyoming.api") propertyCb = cb;
      return () => undefined;
    };
  }

  return {
    app,
    spoken,
    debugLog,
    errorLog,
    statusLog,
    pluginErrorLog,
    selfPaths,
    weatherCalls,
    sendCommand(text, satellite) {
      if (!deltaHandler) throw new Error("plugin never subscribed to deltas");
      deltaHandler({
        updates: [
          { values: [{ path: "voice.command", value: { text, satellite } }] },
        ],
      });
    },
    provideSay(opts = {}) {
      if (!propertyCb)
        throw new Error("plugin never registered for PropertyValues");
      // Mirror the real shape: history is an array, newest last, and entries
      // may carry no say handle at all.
      const history: unknown[] = [
        { value: { version: 1 } },
        { value: { version: 2, say } },
      ];
      // Trailing sayless emissions force the plugin to walk backwards rather
      // than reading the newest entry and giving up.
      for (let i = 0; i < (opts.sayless ?? 0); i++) {
        history.push({ value: { version: 3 + i } });
      }
      propertyCb(history);
    },
    failSayWith(err) {
      sayError = err;
    },
    setWeather(forecasts) {
      app.weatherApi = {
        getForecasts: async (...args: unknown[]) => {
          weatherCalls.push(args);
          if (forecasts instanceof Error) throw forecasts;
          return forecasts;
        },
      };
    },
  };
}

/**
 * Wait until `condition` holds, polling briefly.
 *
 * The delta handler is fire-and-forget, so tests have to wait for an async
 * chain (fetch over loopback, then say()) with no handle to await. A fixed
 * sleep is the obvious approach and is wrong: it either races a slow runner
 * or pads every test with a delay it rarely needs. This CI failed exactly
 * that way on Node 24 — one request had not completed within 60 ms on a cold
 * runner, so the suite was flaky rather than broken.
 *
 * `timeoutMs` is a ceiling, not a delay: a passing assertion returns as soon
 * as the condition is met, usually in a millisecond or two.
 */
export async function waitFor(
  condition: () => boolean,
  message = "condition never became true",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms: ${message}`);
}

/**
 * Let the in-flight delta chain run to completion.
 *
 * Used where a test asserts that something did NOT happen (no reply spoken,
 * no request sent). There is no condition to poll for an absence, so this
 * yields enough turns for any pending work to land. Keep it well above the
 * loopback round-trip time.
 */
export async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
