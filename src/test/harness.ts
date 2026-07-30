// End-to-end harness: stands up a real HTTP server speaking the
// OpenAI-compatible chat API, plus a mock Signal K `app`, so tests can drive
// the actual plugin module the way the server does — load, start(), feed a
// voice.command delta, observe the spoken reply.
//
// Nothing here stubs the plugin's own code: fetch really goes over TCP and the
// PropertyValues / subscriptionmanager plumbing is exercised as written.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

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
  /** Emit the signalk-wyoming.api PropertyValue carrying say(). */
  provideSay(): void;
  /** Make say() reject, as a stopped wyoming would. */
  failSayWith(err: Error): void;
  /** Boat data returned by getSelfPath. */
  selfPaths: Record<string, unknown>;
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
    sendCommand(text, satellite) {
      if (!deltaHandler) throw new Error("plugin never subscribed to deltas");
      deltaHandler({
        updates: [
          { values: [{ path: "voice.command", value: { text, satellite } }] },
        ],
      });
    },
    provideSay() {
      if (!propertyCb)
        throw new Error("plugin never registered for PropertyValues");
      // Mirror the real shape: history is an array, newest last, and earlier
      // entries may carry no say handle at all.
      propertyCb([{ value: { version: 1 } }, { value: { version: 2, say } }]);
    },
    failSayWith(err) {
      sayError = err;
    },
  };
}

/** Let queued promise callbacks run — the delta handler is fire-and-forget. */
export async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
