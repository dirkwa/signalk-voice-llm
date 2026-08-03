// Direct tests for the OpenAI-compatible chat client (src/llm.ts).
//
// chat() uses the global fetch over real TCP, so these drive it against a
// purpose-built loopback server — no mocking. The e2e suite only exercises the
// happy path; here we pin down the request it sends and every failure branch:
// timeout->AbortError mapping, non-2xx body truncation, empty/malformed
// responses, and the auth header.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chat, chatWithTools, type LlmConfig, type ToolSpec } from "../llm";

// A loopback server that captures the request and lets each test dictate the
// response (status, body, hang, or valid completion). Sockets are unref'd so a
// failing assertion can't turn into a CI hang.
interface CapturedRequest {
  method: string;
  path: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

interface FakeServer {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Respond with this JSON object (default: a valid one-choice completion). */
  setJson(obj: unknown): void;
  /** Respond with a raw status + body (bypasses JSON). */
  setRaw(status: number, body: string, contentType?: string): void;
  /** Never respond, so the client's own timeout fires. */
  setHang(hang: boolean): void;
  close(): Promise<void>;
}

async function startServer(): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  let jsonResponse: unknown = {
    choices: [{ message: { role: "assistant", content: "hello there" } }],
  };
  let raw: { status: number; body: string; contentType?: string } | null = null;
  let hang = false;
  const open = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    req.socket.unref();
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf || "null");
      } catch {
        parsed = buf; // record the raw string so a test can inspect it
      }
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: parsed,
      });
      if (hang) {
        open.add(res);
        return;
      }
      if (raw) {
        res.writeHead(raw.status, {
          "Content-Type": raw.contentType ?? "text/plain",
        });
        res.end(raw.body);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonResponse));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setJson(obj) {
      jsonResponse = obj;
      raw = null;
    },
    setRaw(status, body, contentType) {
      raw = { status, body, contentType };
    },
    setHang(h) {
      hang = h;
    },
    async close() {
      for (const r of open) r.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function cfg(baseUrl: string, over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    baseUrl,
    model: "test-model",
    temperature: 0.4,
    maxTokens: 200,
    timeoutMs: 5000,
    ...over,
  };
}

test("sends a well-formed OpenAI chat request", async () => {
  const srv = await startServer();
  await chat(cfg(srv.baseUrl), [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);

  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/chat/completions", "appends the chat path");
  assert.match(req.contentType ?? "", /application\/json/);
  const body = req.body as Record<string, unknown>;
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 200);
  assert.equal(body.stream, false, "must not request streaming");
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  await srv.close();
});

test("returns the assistant reply, trimmed", async () => {
  const srv = await startServer();
  srv.setJson({
    choices: [{ message: { content: "  Depth is 4.2 metres.  \n" } }],
  });
  const res = await chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]);
  assert.equal(res.text, "Depth is 4.2 metres.");
  await srv.close();
});

test("sends an Authorization header only when an API key is set", async () => {
  const srv = await startServer();
  await chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]);
  assert.equal(
    srv.requests[0]!.authorization,
    undefined,
    "no key -> no auth header (correct for local servers)",
  );

  await chat(cfg(srv.baseUrl, { apiKey: "sk-secret" }), [
    { role: "user", content: "x" },
  ]);
  assert.equal(srv.requests[1]!.authorization, "Bearer sk-secret");
  await srv.close();
});

test("maps a timeout to a clear error, not a raw AbortError", async () => {
  const srv = await startServer();
  srv.setHang(true);
  await assert.rejects(
    () =>
      chat(cfg(srv.baseUrl, { timeoutMs: 150 }), [
        { role: "user", content: "x" },
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out after 150 ms/);
      assert.notEqual(
        err.name,
        "AbortError",
        "the raw AbortError must be wrapped",
      );
      return true;
    },
  );
  await srv.close();
});

test("surfaces a non-2xx status with a truncated body", async () => {
  const srv = await startServer();
  const bigBody = "x".repeat(500);
  srv.setRaw(500, bigBody);
  await assert.rejects(
    () => chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /LLM HTTP 500/);
      // The body is included but capped at 200 chars so a huge error page
      // can't flood the logs / status.
      assert.ok(err.message.includes("x".repeat(200)));
      assert.ok(
        !err.message.includes("x".repeat(201)),
        "body must be truncated",
      );
      return true;
    },
  );
  await srv.close();
});

test("a non-2xx with no body still reports the status", async () => {
  const srv = await startServer();
  srv.setRaw(429, "");
  await assert.rejects(
    () => chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]),
    /LLM HTTP 429/,
  );
  await srv.close();
});

test("throws on an empty assistant message", async () => {
  const srv = await startServer();
  srv.setJson({ choices: [{ message: { content: "   " } }] });
  await assert.rejects(
    () => chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]),
    /empty response/,
  );
  await srv.close();
});

test("throws on a response with no choices", async () => {
  const srv = await startServer();
  srv.setJson({ choices: [] });
  await assert.rejects(
    () => chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]),
    /empty response/,
  );
  await srv.close();
});

test("throws on a 200 with malformed JSON", async () => {
  const srv = await startServer();
  srv.setRaw(200, "<html>not json</html>", "application/json");
  await assert.rejects(
    () => chat(cfg(srv.baseUrl), [{ role: "user", content: "x" }]),
    (err: unknown) => err instanceof Error, // any parse error propagates
  );
  await srv.close();
});

test("tolerates a trailing slash on the base URL", async () => {
  const srv = await startServer();
  await chat(cfg(`${srv.baseUrl}///`), [{ role: "user", content: "x" }]);
  assert.equal(
    srv.requests[0]!.path,
    "/v1/chat/completions",
    "collapses trailing slashes, no //chat/completions",
  );
  await srv.close();
});

// --- chatWithTools() ------------------------------------------------------
//
// Same transport as chat() (shared postCompletion), but it sends `tools` +
// `tool_choice` and returns the assistant turn WHOLE — content, tool_calls, and
// finish_reason — because a tool-call turn has no prose and must not be treated
// as the "empty response" error chat() raises.

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "fsk__set_view",
      description: "center the map",
      parameters: {
        type: "object",
        properties: { longitude: { type: "number" } },
      },
    },
  },
];

test("chatWithTools sends tools and tool_choice in the body", async () => {
  const srv = await startServer();
  srv.setJson({ choices: [{ message: { content: "ok" } }] });
  await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "x" }],
    TOOLS,
  );
  const body = srv.requests[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.tools, TOOLS, "the tool list is sent verbatim");
  assert.equal(body.tool_choice, "auto", "defaults to auto");
  assert.equal(body.stream, false);
  await srv.close();
});

test("chatWithTools honours an explicit tool_choice of none", async () => {
  const srv = await startServer();
  srv.setJson({ choices: [{ message: { content: "done" } }] });
  await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "x" }],
    TOOLS,
    "none",
  );
  const body = srv.requests[0]!.body as Record<string, unknown>;
  assert.equal(body.tool_choice, "none");
  await srv.close();
});

test("chatWithTools returns tool_calls with an empty content, not an error", async () => {
  const srv = await startServer();
  // A pure tool-call turn: content is null, the model wants to run a tool.
  srv.setJson({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "fsk__set_view",
                arguments: '{"longitude":174.7}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const turn = await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "center the map" }],
    TOOLS,
  );
  assert.equal(turn.content, "", "no prose on a tool turn — not an error");
  assert.equal(turn.finishReason, "tool_calls");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]!.id, "call_1");
  assert.equal(turn.toolCalls[0]!.function.name, "fsk__set_view");
  assert.equal(turn.toolCalls[0]!.function.arguments, '{"longitude":174.7}');
  await srv.close();
});

test("chatWithTools returns the final prose turn with no tool_calls", async () => {
  const srv = await startServer();
  srv.setJson({
    choices: [
      {
        message: { content: "  Centred on the marina.  " },
        finish_reason: "stop",
      },
    ],
  });
  const turn = await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "x" }],
    TOOLS,
  );
  assert.equal(turn.content, "Centred on the marina.", "prose is trimmed");
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.finishReason, "stop");
  await srv.close();
});

test("chatWithTools maps a timeout the same way chat does", async () => {
  const srv = await startServer();
  srv.setHang(true);
  await assert.rejects(
    () =>
      chatWithTools(
        cfg(srv.baseUrl, { timeoutMs: 150 }),
        [{ role: "user", content: "x" }],
        TOOLS,
      ),
    /timed out after 150 ms/,
  );
  await srv.close();
});

test("chatWithTools drops malformed tool_calls, keeps the well-formed ones", async () => {
  const srv = await startServer();
  // A flaky model can emit junk entries: missing id, missing function, a
  // non-string arguments. The good one must survive; the rest are dropped so
  // the loop never dereferences undefined or dispatches garbage.
  srv.setJson({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "ok",
              type: "function",
              function: { name: "a", arguments: '{"x":1}' },
            },
            { type: "function", function: { name: "no_id" } }, // missing id
            { id: "no_fn", type: "function" }, // missing function
            { id: "n", type: "function", function: { name: 42 } }, // non-string name
            { id: "coerce", type: "function", function: { name: "b" } }, // arguments absent -> ""
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const turn = await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "x" }],
    TOOLS,
  );
  assert.equal(turn.toolCalls.length, 2, "only the two valid calls survive");
  assert.equal(turn.toolCalls[0]!.id, "ok");
  assert.equal(turn.toolCalls[0]!.function.arguments, '{"x":1}');
  assert.equal(turn.toolCalls[1]!.id, "coerce");
  assert.equal(
    turn.toolCalls[1]!.function.arguments,
    "",
    "absent arguments normalised to empty string",
  );
  await srv.close();
});

test("chatWithTools tolerates a response with no choices", async () => {
  const srv = await startServer();
  srv.setJson({ choices: [] });
  const turn = await chatWithTools(
    cfg(srv.baseUrl),
    [{ role: "user", content: "x" }],
    TOOLS,
  );
  assert.equal(turn.content, "", "no choices -> empty content, no throw");
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.finishReason, "");
  await srv.close();
});
