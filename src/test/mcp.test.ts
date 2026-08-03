// Direct tests for the MCP-over-Streamable-HTTP client (src/mcp.ts).
//
// The client speaks JSON-RPC to a real loopback server that mimics the
// fsk-mcp wire contract: initialize returns an Mcp-Session-Id header, later
// requests must echo it, tools/list and tools/call return MCP-shaped results.
// Nothing here needs a live LLM, FSK, or the SDK — it pins the protocol the
// client must speak so a real server (fsk-mcp) works without a round trip to it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpClient } from "../mcp";

interface CapturedRequest {
  method: string;
  sessionId?: string;
  accept?: string;
  authorization?: string;
  host?: string;
  body: { method?: string; id?: unknown; params?: unknown } | null;
}

// Behaviour knobs a test can flip to exercise a branch.
interface Behaviour {
  // Fail the NEXT non-initialize request with this status once, then recover
  // (models an expired session that triggers a re-initialize + retry).
  failNextWith?: number;
  // Return the tools/call result marked as an error.
  toolCallIsError?: boolean;
  // Never respond, so the client's timeout fires.
  hang?: boolean;
  // Respond to tools/call as SSE rather than plain JSON.
  sse?: boolean;
  // Omit the session-id header on initialize (protocol violation).
  noSessionHeader?: boolean;
}

interface FakeMcp {
  url: string;
  requests: CapturedRequest[];
  sessions: string[];
  behaviour: Behaviour;
  close(): Promise<void>;
}

async function startMcp(): Promise<FakeMcp> {
  const requests: CapturedRequest[] = [];
  const sessions: string[] = [];
  const behaviour: Behaviour = {};
  const open = new Set<http.ServerResponse>();
  let sessionCounter = 0;

  const server = http.createServer((req, res) => {
    req.socket.unref();
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      let body: CapturedRequest["body"];
      try {
        body = buf ? JSON.parse(buf) : null;
      } catch {
        body = null;
      }
      requests.push({
        method: req.method ?? "",
        sessionId: req.headers["mcp-session-id"] as string | undefined,
        accept: req.headers["accept"] as string | undefined,
        authorization: req.headers["authorization"] as string | undefined,
        host: req.headers["host"] as string | undefined,
        body,
      });

      if (behaviour.hang) {
        open.add(res);
        return;
      }

      // DELETE — session teardown.
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }

      const rpcMethod = body?.method;

      // A notification (no id) is acknowledged with 202 and no body.
      if (rpcMethod && body?.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      if (rpcMethod === "initialize") {
        const sid = `sess-${++sessionCounter}`;
        sessions.push(sid);
        const headers: http.OutgoingHttpHeaders = {
          "Content-Type": "application/json",
        };
        if (!behaviour.noSessionHeader) headers["Mcp-Session-Id"] = sid;
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
        );
        return;
      }

      // Optionally fail the next real (post-init) request once to trigger a
      // re-init + retry, then serve normally.
      if (behaviour.failNextWith && rpcMethod !== "initialize") {
        const status = behaviour.failNextWith;
        behaviour.failNextWith = undefined;
        res.writeHead(status).end("session expired");
        return;
      }

      if (rpcMethod === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id,
            result: {
              tools: [
                {
                  name: "fsk_set_view",
                  description: "center the map",
                  inputSchema: {
                    type: "object",
                    properties: { longitude: { type: "number" } },
                  },
                },
                { name: "no_schema" }, // exercises the default-schema fallback
              ],
            },
          }),
        );
        return;
      }

      if (rpcMethod === "tools/call") {
        const payload = {
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            content: [{ type: "text", text: "centered" }],
            ...(behaviour.toolCallIsError ? { isError: true } : {}),
          },
        };
        if (behaviour.sse) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }
        return;
      }

      res.writeHead(400).end("unknown method");
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    sessions,
    behaviour,
    async close() {
      for (const r of open) r.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("initialize captures the session id and sends the right headers", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();

  const init = srv.requests.find((r) => r.body?.method === "initialize")!;
  assert.ok(init, "sent an initialize request");
  assert.match(init.accept ?? "", /application\/json/);
  assert.match(init.accept ?? "", /text\/event-stream/);
  assert.equal(init.sessionId, undefined, "no session id on initialize");
  // The next request carries the returned session id.
  await client.listTools();
  const list = srv.requests.find((r) => r.body?.method === "tools/list")!;
  assert.equal(list.sessionId, srv.sessions[0], "echoes the session id");
  await srv.close();
});

test("initialize sends the initialized notification", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  const note = srv.requests.find(
    (r) => r.body?.method === "notifications/initialized",
  );
  assert.ok(note, "acknowledges readiness after initialize");
  assert.equal(note!.body?.id, undefined, "a notification carries no id");
  await srv.close();
});

test("listTools maps names, descriptions, and a default schema", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, "fsk_set_view");
  assert.equal(tools[0]!.description, "center the map");
  assert.deepEqual(tools[0]!.inputSchema, {
    type: "object",
    properties: { longitude: { type: "number" } },
  });
  // A tool with no inputSchema still gets a valid object schema.
  assert.deepEqual(tools[1]!.inputSchema, { type: "object", properties: {} });
  await srv.close();
});

test("callTool joins text content and reports success", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  const res = await client.callTool("fsk_set_view", { longitude: 174.7 });
  assert.equal(res.text, "centered");
  assert.equal(res.isError, false);
  const call = srv.requests.find((r) => r.body?.method === "tools/call")!;
  assert.deepEqual(call.body?.params, {
    name: "fsk_set_view",
    arguments: { longitude: 174.7 },
  });
  await srv.close();
});

test("callTool surfaces a server-flagged tool error without throwing", async () => {
  const srv = await startMcp();
  srv.behaviour.toolCallIsError = true;
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  const res = await client.callTool("fsk_set_view", {});
  assert.equal(res.isError, true, "isError propagates, no throw");
  assert.equal(res.text, "centered");
  await srv.close();
});

test("callTool parses an SSE (event-stream) response", async () => {
  const srv = await startMcp();
  srv.behaviour.sse = true;
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  const res = await client.callTool("fsk_set_view", {});
  assert.equal(res.text, "centered", "the data: line is parsed");
  await srv.close();
});

test("an expired session triggers a re-initialize and retry", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.connect();
  srv.behaviour.failNextWith = 404; // next tools/call 404s once
  const res = await client.callTool("fsk_set_view", {});
  assert.equal(res.text, "centered", "recovered after re-init");
  assert.equal(srv.sessions.length, 2, "a second session was created");
  await srv.close();
});

test("sends the Authorization header when a token is set", async () => {
  const srv = await startMcp();
  const client = new McpClient({
    url: srv.url,
    token: "secret",
    timeoutMs: 3000,
  });
  await client.connect();
  const init = srv.requests[0]!;
  assert.equal(init.authorization, "Bearer secret");
  await srv.close();
});

test("maps a timeout to a clear error", async () => {
  const srv = await startMcp();
  srv.behaviour.hang = true;
  const client = new McpClient({ url: srv.url, timeoutMs: 150 });
  await assert.rejects(() => client.connect(), /timed out after 150 ms/);
  await srv.close();
});

test("throws when initialize returns no session id", async () => {
  const srv = await startMcp();
  srv.behaviour.noSessionHeader = true;
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await assert.rejects(
    () => client.connect(),
    /did not return an Mcp-Session-Id/,
  );
  await srv.close();
});

test("close sends a DELETE and is safe when never connected", async () => {
  const srv = await startMcp();
  const client = new McpClient({ url: srv.url, timeoutMs: 3000 });
  await client.close(); // no session yet — must be a no-op, no throw
  await client.connect();
  await client.close();
  const del = srv.requests.find((r) => r.method === "DELETE");
  assert.ok(del, "a connected client tears down its session");
  await srv.close();
});
