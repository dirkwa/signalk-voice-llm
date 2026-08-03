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
  close(): Promise<void>;
}

async function startMcp(): Promise<FakeMcp> {
  const calls: FakeMcp["calls"] = [];
  const state = { toolError: false };
  const server = http.createServer((req, res) => {
    req.socket.unref();
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const body = buf ? JSON.parse(buf) : {};
      if (req.method === "DELETE") return void res.writeHead(200).end();
      if (body.method && body.id === undefined)
        return void res.writeHead(202).end(); // notification
      if (body.method === "initialize") {
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
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "set_view",
                  description: "center the map",
                  inputSchema: {
                    type: "object",
                    properties: { longitude: { type: "number" } },
                  },
                },
              ],
            },
          }),
        );
      }
      if (body.method === "tools/call") {
        calls.push({
          name: body.params?.name,
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
  assert.equal(toolset.tools.length, 1);
  assert.equal(
    toolset.tools[0]!.function.name,
    "fsk__set_view",
    "server name is prefixed with __",
  );
  assert.deepEqual(toolset.tools[0]!.function.parameters, {
    type: "object",
    properties: { longitude: { type: "number" } },
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

test("drops the reply if the plugin stops mid-loop", async () => {
  const mcp = await startMcp();
  const llm = await startLlm([
    { toolCalls: [{ id: "c1", name: "fsk__set_view", arguments: "{}" }] },
    { content: "should never be spoken" },
  ]);
  const toolset = new Toolset([{ name: "fsk", url: mcp.url }], 3000);
  await toolset.connect();
  let alive = true;
  const res = await runConversation(
    cfg(llm.baseUrl),
    [{ role: "user", content: "center the map" }],
    toolset,
    loopOpts({
      // Stop after the first tool round: flips false before the 2nd LLM call.
      stillRunning: () => {
        const wasAlive = alive;
        alive = false;
        return wasAlive;
      },
    }),
  );
  assert.equal(res.text, "", "a stopped plugin speaks nothing");
  await toolset.close();
  await llm.close();
  await mcp.close();
});

test("a server that won't connect is skipped, leaving no tools", async () => {
  // Point at a closed port — connect() must swallow it and expose no tools.
  const toolset = new Toolset(
    [{ name: "dead", url: "http://127.0.0.1:1/mcp" }],
    300,
  );
  await toolset.connect();
  assert.equal(toolset.hasTools, false);
  await toolset.close();
});
