import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createFramer, dispatch, serve, PROTOCOL_VERSION } from "../plugins/truffle-swarm/lib/jsonrpc.mjs";

test("messages split on newlines even when a chunk arrives in pieces", () => {
  const seen = [];
  const push = createFramer((line) => seen.push(line));
  push('{"a":1}\n{"b":');
  push('2}\n\n{"c":3}\n');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("a notification gets no reply, and an unknown method does", async () => {
  const handlers = { seen: () => ({ ok: true }) };
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "seen" }, handlers), undefined);
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "absent" }, handlers), undefined);
  const answer = await dispatch({ jsonrpc: "2.0", id: 1, method: "absent" }, handlers);
  assert.equal(answer.error.code, -32601);
});

test("a handler that throws becomes an error response, not a crash", async () => {
  const answer = await dispatch({ jsonrpc: "2.0", id: 4, method: "boom" }, {
    boom: () => {
      throw Error("no good");
    },
  });
  assert.equal(answer.error.code, -32603);
  assert.equal(answer.error.message, "no good");
});

test("a request that is not JSON-RPC 2.0 is refused", async () => {
  const answer = await dispatch({ id: 1, method: "x" }, { x: () => ({}) });
  assert.equal(answer.error.code, -32600);
});

async function session(options) {
  const input = new PassThrough();
  const output = new PassThrough();
  serve({ input, output, name: "test", version: "1.0.0", ...options });
  const replies = [];
  output.on("data", (chunk) =>
    replies.push(...String(chunk).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))),
  );
  return {
    raw: (text) => input.write(text),
    async call(message) {
      input.write(JSON.stringify(message) + "\n");
      await new Promise((done) => setTimeout(done, 20));
      return replies.at(-1);
    },
    replies,
  };
}

test("initialize answers with the protocol version, capabilities and instructions", async () => {
  const mcp = await session({ instructions: "Start with swarm_context.", tools: [], resources: [] });
  const result = (await mcp.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).result;
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(result.serverInfo.name, "test");
  assert.equal(result.instructions, "Start with swarm_context.");
  assert.equal(result.capabilities.tools.listChanged, false);
});

test("tools are listed with their schema and run on request", async () => {
  const mcp = await session({
    tools: [
      {
        name: "swarm_echo",
        description: "Echo",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
        run: async ({ text }) => ({ echoed: text }),
      },
    ],
  });
  const listed = (await mcp.call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result;
  assert.equal(listed.tools[0].name, "swarm_echo");
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);

  const called = (await mcp.call({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "swarm_echo", arguments: { text: "hi" } },
  })).result;
  assert.deepEqual(called.structuredContent, { echoed: "hi" });
  assert.deepEqual(JSON.parse(called.content[0].text), { echoed: "hi" });
});

test("a tool failure is reported inside the result, with the server's status", async () => {
  const mcp = await session({
    tools: [
      {
        name: "swarm_write",
        description: "Write",
        inputSchema: { type: "object" },
        run: async () => {
          const error = Error("409: Conflict");
          error.toJSON = () => ({ error: "409: Conflict", status: 409, currentRevision: 5 });
          throw error;
        },
      },
    ],
  });
  const result = (await mcp.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "swarm_write" } })).result;
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { error: "409: Conflict", status: 409, currentRevision: 5 });
});

test("resources are listed and read", async () => {
  const mcp = await session({
    resources: [
      {
        uri: "swarm://context",
        name: "Swarm context",
        mimeType: "application/json",
        read: async () => ({ actor: "agent-self" }),
      },
    ],
  });
  assert.equal((await mcp.call({ jsonrpc: "2.0", id: 6, method: "resources/list" })).result.resources[0].uri, "swarm://context");
  const read = (await mcp.call({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "swarm://context" } })).result;
  assert.deepEqual(JSON.parse(read.contents[0].text), { actor: "agent-self" });
});

test("malformed input is answered with a parse error and the server stays up", async () => {
  const mcp = await session({ tools: [] });
  mcp.raw("{not json\n");
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(mcp.replies.at(-1).error.code, -32700);
  assert.deepEqual((await mcp.call({ jsonrpc: "2.0", id: 8, method: "ping" })).result, {});
});
