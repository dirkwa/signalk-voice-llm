// Tests for the tool-calling loop (src/tools.ts).
//
// These drive the REAL loop against two real loopback servers: a scripted LLM
// that returns tool_calls then a final answer, and an MCP stub that serves a
// tool. Nothing is mocked — chatWithTools() and McpClient both go over TCP, so
// the test proves the loop terminates with a spoken summary and that the right
// tools/call reached the server. No live FSK, no hosted model.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Toolset, runConversation } from "../tools";
import type { LlmConfig } from "../llm";

// --- a scripted OpenAI chat server --------------------------------------
//
// Each call pops the next scripted assistant message. A script entry is either
// prose ({ content }) or tool calls ({ toolCalls }). The server records every
// request body so a test can assert on the messages the loop sent.

type ScriptEntry =
  | { content: string }
  | {
      toolCalls: { id: string; name: string; arguments: string }[];
    };

interface FakeLlm {
  baseUrl: string;
  requests: unknown[];
  script: ScriptEntry[];
  close(): Promise<void>;
}

async function startLlm(script: ScriptEntry[]): Promise<FakeLlm> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    req.socket.unref();
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(buf || "null"));
      } catch {
        requests.push(buf);
      }
      const entry = script.shift() ?? { content: "no more script" };
      const message =
        "toolCalls" in entry
          ? {
              role: "assistant",
              content: null,
              tool_calls: entry.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: t.arguments },
              })),
            }
          : { role: "assistant", content: entry.content };
      const finish = "toolCalls" in entry ? "tool_calls" : "stop";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message, finish_reason: finish }] }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// --- a minimal MCP stub (one tool) --------------------------------------

interface FakeMcp {
  url: string;
  calls: { name: string; arguments: unknown }[];
  toolError: boolean;
  /** Reject this many initialize attempts with a 503 before succeeding. */
  failInitCount: number;
  close(): Promise<void>;
}

// `toolNames` overrides the advertised tool list (default: a single set_view)
// so a test can exercise name truncation / collision handling.
async function startMcp(toolNames?: string[]): Promise<FakeMcp> {
  const tools = (toolNames ?? ["set_view"]).map((name) => ({
    name,
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
  }));
  const calls: FakeMcp["calls"] = [];
  const state = { toolError: false, failInitCount: 0 };
  const server = http.createServer((req, res) => {
    req.socket.unref();
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      // DELETE (session teardown) carries no body — handle it before parsing.
      if (req.method === "DELETE") return void res.writeHead(200).end();
      let body: {
        method?: string;
        id?: unknown;
        params?: { name?: string; arguments?: unknown };
      };
      try {
        body = buf ? JSON.parse(buf) : {};
      } catch {
        // A parse throw inside req.on("end") would be an uncaught exception that
        // aborts the whole test run, not a single assertion failure.
        return void res.writeHead(400).end();
      }
      if (body.method && body.id === undefined)
        return void res.writeHead(202).end(); // notification
      if (body.method === "initialize") {
        if (state.failInitCount > 0) {
          state.failInitCount--;
          return void res.writeHead(503).end("not ready");
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "s1",
        });
        return void res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
        );
      }
      if (body.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }),
        );
      }
      if (body.method === "tools/call") {
        calls.push({
          name: body.params?.name ?? "",
          arguments: body.params?.arguments,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "the map is centered" }],
              ...(state.toolError ? { isError: true } : {}),
            },
          }),
        );
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    get toolError() {
      return state.toolError;
    },
    set toolError(v: boolean) {
      state.toolError = v;
    },
    get failInitCount() {
      return state.failInitCount;
    },
    set failInitCount(v: number) {
      state.failInitCount = v;
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function cfg(baseUrl: string): LlmConfig {
  return {
    baseUrl,
    model: "test-model",
    temperature: 0.4,
    maxTokens: 200,
    timeoutMs: 3000,
  };
}

const loopOpts = (
  over: Partial<Parameters<typeof runConversation>[3]> = {},
) => ({
  maxIterations: 3,
  conversationBudgetMs: 30000,
  now: () => 0,
  stillRunning: () => true,
  ...over,
});

test("discovers, namespaces, and offers MCP tools to the model", async () => {
  const mcp = await startMcp();
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  assert.equal(toolset.hasTools, true);
  assert.equal(toolset.mcpTools.length, 1);
  assert.equal(
    toolset.mcpTools[0]!.function.name,
    "fsk__set_view",
    "server name is prefixed with __",
  );
  assert.deepEqual(toolset.mcpTools[0]!.function.parameters, {
    type: "object",
    properties: {},
  });
  await toolset.close();
  await mcp.close();
});

test("runs a tool call, feeds the result back, and speaks the summary", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    {
      toolCalls: [
        {
          id: "c1",
          name: "fsk__set_view",
          arguments: '{"longitude":174.7}',
        },
      ],
    },
    { content: "Done — I've centred the chart on the marina." },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();

  const res = await runConversation(
    cfg(llm.baseUrl),
    [
      { role: "system", content: "sys" },
      { role: "user", content: "center the map on the marina" },
    ],
    toolset,
    loopOpts(),
  );

  assert.equal(res.text, "Done — I've centred the chart on the marina.");
  assert.equal(res.rounds, 1);
  // The tool actually reached the MCP server with the model's args.
  assert.equal(mcp.calls.length, 1);
  assert.equal(mcp.calls[0]!.name, "set_view", "un-namespaced on the wire");
  assert.deepEqual(mcp.calls[0]!.arguments, { longitude: 174.7 });
  // The second LLM request carried the assistant tool-call turn + the tool
  // result message, so the model saw the outcome.
  const second = llm.requests[1] as { messages: { role: string }[] };
  const roles = second.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);

  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("answers without tools when the model doesn't call any", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([{ content: "Your depth is 4.2 metres." }]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "what's my depth" }],
    toolset,
    loopOpts(),
  );
  assert.equal(res.text, "Your depth is 4.2 metres.");
  assert.equal(res.rounds, 0, "no tool round happened");
  assert.equal(mcp.calls.length, 0);
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("a tool error is fed back so the model can still answer", async () => {
  const mcp = await startMcp();
  mcp.toolError = true;
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "{}" }] },
    { content: "I couldn't move the chart — the plotter didn't respond." },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "center the map" }],
    toolset,
    loopOpts(),
  );
  assert.match(res.text, /couldn't move the chart/);
  // The tool message fed back to the model carried the error text.
  const second = llm.requests[1] as {
    messages: { role: string; content: string }[];
  };
  const toolMsg = second.messages.find((m) => m.role === "tool")!;
  assert.match(toolMsg.content, /^error:/);
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("an unknown tool name is reported back, never dispatched", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__does_not_exist", arguments: "{}" }] },
    { content: "That isn't something I can do." },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "do a thing" }],
    toolset,
    loopOpts(),
  );
  assert.equal(res.text, "That isn't something I can do.");
  assert.equal(mcp.calls.length, 0, "no bad call reached the server");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("rejects non-object tool arguments without dispatching", async () => {
  const mcp = await startMcp();
  // A flaky model can emit a bare scalar/null as arguments, which is not a
  // valid tools/call payload — it must be reported back, not sent.
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "5" }] },
    { content: "I couldn't run that." },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "do a thing" }],
    toolset,
    loopOpts(),
  );
  assert.equal(res.text, "I couldn't run that.");
  assert.equal(
    mcp.calls.length,
    0,
    "the scalar-args call never reached the server",
  );
  const second = llm.requests[1] as {
    messages: { role: string; content: string }[];
  };
  const toolMsg = second.messages.find((m) => m.role === "tool")!;
  assert.match(toolMsg.content, /must be a JSON object/);
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("hitting the iteration cap forces a tool-free summary turn", async () => {
  const mcp = await startMcp();
  // The model keeps asking for tools every round; the cap must break the loop
  // and force one final tool_choice:none turn.
  const llm = await startLlm([
    { toolCalls: [{ id: "a", name: "fsk__set_view", arguments: "{}" }] },
    { toolCalls: [{ id: "b", name: "fsk__set_view", arguments: "{}" }] },
    { content: "Here's what I found after looking around." }, // forced turn
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "keep going" }],
    toolset,
    loopOpts({ maxIterations: 2 }),
  );
  assert.equal(res.text, "Here's what I found after looking around.");
  // The final (3rd) LLM request must have forced tool_choice:"none".
  const forced = llm.requests[2] as { tool_choice: string };
  assert.equal(forced.tool_choice, "none");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("drops the reply if the plugin stops before the first LLM turn", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "{}" }] },
    { content: "should never be spoken" },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  // stillRunning yields true once (the loop-top check consumes it) then false
  // at the post-LLM check, so the loop bails before any tool round.
  let alive = true;
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "center the map" }],
    toolset,
    loopOpts({
      stillRunning: () => {
        const wasAlive = alive;
        alive = false;
        return wasAlive;
      },
    }),
  );
  assert.equal(res.text, "", "a stopped plugin speaks nothing");
  assert.equal(res.rounds, 0, "bailed before running a tool round");
  assert.equal(mcp.calls.length, 0, "no tool call reached the server");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("drops the reply if the plugin stops after a tool round runs", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "{}" }] },
    { content: "should never be spoken" },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  // Alive for the loop-top and post-LLM checks of the FIRST iteration (so one
  // tool round runs), then dead at the second iteration's loop-top check.
  let calls = 0;
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "center the map" }],
    toolset,
    loopOpts({
      stillRunning: () => ++calls <= 2,
    }),
  );
  assert.equal(res.text, "", "a stopped plugin speaks nothing");
  assert.equal(res.rounds, 1, "one tool round ran before the stop");
  assert.equal(mcp.calls.length, 1, "the tool ran before we bailed");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("a server that won't connect is skipped, leaving no tools", async () => {
  // Point at a closed port — connect() must swallow it and expose no tools.
  const toolset = new Toolset(
    [{ name: "dead", url: "http://127.0.0.1:1/mcp" }],
    300,
    () => {},
    { maxAttempts: 2, backoffMs: 10 }, // fast: don't wait the production backoff
  );
  await toolset.connect();
  // Local tools are always registered; assert no SERVER tools survived.
  assert.equal(toolset.mcpTools.length, 0);
  await toolset.close();
});

test("retries a server that isn't ready yet, then connects", async () => {
  // Model the boot race: the MCP server rejects the first initialize attempts
  // (as if it hasn't finished binding), then comes up. The toolset must retry
  // and end up with tools rather than giving up on the first failure.
  const mcp = await startMcp();
  mcp.failInitCount = 2; // fail the first two initialize attempts
  const logs: string[] = [];
  const toolset = new Toolset(
    [{ name: "fsk", url: mcp.url }],
    2000,
    (m) => logs.push(m),
    { maxAttempts: 4, backoffMs: 50 },
  );
  await toolset.connect();
  assert.equal(toolset.hasTools, true, "retry recovered after early failures");
  // Exactly two "not ready … retrying" lines: an unbounded retry, or the
  // production 2000 ms backoff instead of the override, would change this.
  const retries = logs.filter((l) => /not ready .*retrying/.test(l));
  assert.equal(retries.length, 2, "retried exactly twice before connecting");
  await toolset.close();
  await mcp.close();
});

test("an exhausted budget stops the loop and skips the summary request", async () => {
  const mcp = await startMcp();
  // Round 1 calls a tool; the clock then jumps past the deadline, so the loop
  // breaks AND the forced summary is skipped (firing it would overrun the
  // budget). The reply falls back to the give-up line, and only the one round's
  // request reached the LLM.
  const llm = await startLlm([
    { toolCalls: [{ id: "a", name: "fsk__set_view", arguments: "{}" }] },
    { content: "should never be requested" },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  // 0 for the deadline calc and the first round's start-gate, then past the
  // 1000 ms deadline for every check afterward.
  let call = 0;
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "keep going" }],
    toolset,
    loopOpts({
      maxIterations: 10, // high, so only the budget can stop it
      conversationBudgetMs: 1000,
      now: () => (call++ < 2 ? 0 : 5000),
    }),
  );
  assert.equal(res.text, "Sorry, I couldn't finish that.");
  assert.equal(res.rounds, 1, "one round ran before the budget tripped");
  assert.equal(llm.requests.length, 1, "no summary request past the deadline");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("does not mutate the caller's messages array", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "{}" }] },
    { content: "done" },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const messages = [{ role: "user" as const, content: "center the map" }];
  await runConversation(cfg(llm.baseUrl), messages, toolset, loopOpts());
  assert.equal(messages.length, 1, "the caller's array is untouched");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("truncates long tool names and disambiguates collisions within 64 chars", async () => {
  // Two names that collide after the 64-char truncation, plus an over-long one.
  const longA = "a".repeat(80);
  const longB = longA.slice(0, 79) + "b"; // shares the first 79 chars
  const mcp = await startMcp([longA, longB, "short"]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  const names = toolset.mcpTools.map((t) => t.function.name);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, "all names are distinct");
  for (const n of names) {
    assert.ok(n.length <= 64, `"${n}" must be <= 64 chars`);
  }
  await toolset.close();
  await mcp.close();
});

test("caps the tool surface per server and logs the drop", async () => {
  // More tools than MAX_TOOLS_PER_SERVER (32): the excess must be dropped.
  const many = Array.from({ length: 40 }, (_, i) => `tool_${i}`);
  const logs: string[] = [];
  const mcp = await startMcp(many);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000, (m) =>
    logs.push(m),
  );
  await toolset.connect();
  assert.equal(toolset.mcpTools.length, 32, "surface is capped at 32");
  assert.ok(
    logs.some((l) => /capping at 32/.test(l)),
    "logs what was dropped",
  );
  await toolset.close();
  await mcp.close();
});

test("where_am_i is offered without any MCP server and resolves the country", async () => {
  const toolset = new Toolset(
    [],
    3000,
    () => {},
    {},
    () => ({
      latitude: -17.7696627,
      longitude: 177.1802972,
    }),
  );
  await toolset.connect();
  // No servers: the local tool is the whole surface, and the loop must still
  // be worth running.
  assert.equal(toolset.mcpTools.length, 0);
  assert.equal(toolset.hasTools, true);
  assert.ok(
    toolset.tools.some((t) => t.function.name === "where_am_i"),
    "where_am_i is offered",
  );
  // Called with no arguments, it falls back to the live position.
  assert.match(await toolset.call("where_am_i", "{}"), /Fiji/);
  // Explicit arguments win over the supplier.
  assert.match(
    await toolset.call("where_am_i", '{"latitude":-27.47,"longitude":153.02}'),
    /Australia/,
  );
  await toolset.close();
});

test("where_am_i reports a usable error instead of guessing", async () => {
  const toolset = new Toolset(
    [],
    3000,
    () => {},
    {},
    () => ({}),
  );
  await toolset.connect();
  // No fix and no arguments: say so rather than name a country.
  assert.match(await toolset.call("where_am_i", "{}"), /^error: no position/);
  // Swapped lat/long (a common model mistake) must not silently resolve.
  assert.match(
    await toolset.call("where_am_i", '{"latitude":177.18,"longitude":-17.77}'),
    /^error: .*out of range/,
  );
  await toolset.close();
});

test("where_am_i rejects a half-supplied coordinate rather than mixing", async () => {
  // Boat is in Fiji. A model that supplies only one component used to have it
  // fused with the live value for the other, answering confidently about a
  // position neither describes — and "open ocean" reads as authoritative, so
  // the wrong answer was harder to spot than the guess this tool replaced.
  const toolset = new Toolset(
    [],
    3000,
    () => {},
    {},
    () => ({ latitude: -17.7696627, longitude: 177.1802972 }),
  );
  await toolset.connect();
  for (const args of [
    '{"latitude":-27.47}',
    '{"longitude":153.02}',
    // Present but unusable: null/NaN-ish values must not fall through to the
    // live position either, or the same fusion happens by another route.
    '{"latitude":-27.47,"longitude":null}',
    '{"latitude":"south","longitude":153.02}',
  ]) {
    assert.match(
      await toolset.call("where_am_i", args),
      /^error: latitude and longitude must be supplied together/,
      `half-supplied coordinate must be rejected: ${args}`,
    );
  }
  // The no-argument fallback still works — this must not break the common path.
  assert.match(await toolset.call("where_am_i", "{}"), /Fiji/);
  await toolset.close();
});

test("where_am_i ignores a non-finite live position", async () => {
  // A GPS path can be present but hold nulls before a fix; that must read as
  // "no position", not be handed to the geocoder.
  const toolset = new Toolset(
    [],
    3000,
    () => {},
    {},
    () => ({
      latitude: Number.NaN,
      longitude: 177.18,
    }),
  );
  await toolset.connect();
  assert.match(await toolset.call("where_am_i", "{}"), /^error: no position/);
  await toolset.close();
});
