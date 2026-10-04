import test from "node:test";
import assert from "node:assert/strict";
import { toolsFor, INSTRUCTIONS } from "../plugins/truffle-swarm/bin/swarm-mcp.mjs";
import { mcpOperations } from "../plugins/truffle-swarm/lib/operations.mjs";

const recorder = () => {
  const calls = [];
  return [calls, async (path, body) => (calls.push({ path, body }), { ok: true })];
};

test("every shared operation that should be a tool is one", () => {
  const [, call] = recorder();
  const tools = toolsFor(call);
  assert.equal(tools.length, mcpOperations.length);
  assert.ok(tools.some((tool) => tool.name === "swarm_context"));
  assert.ok(tools.some((tool) => tool.name === "swarm_page_write"));
  assert.ok(!tools.some((tool) => tool.name.includes("export")));
});

test("read tools are annotated read-only and write tools are not", () => {
  const [, call] = recorder();
  const tools = new Map(toolsFor(call).map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.get("swarm_context").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(tools.get("swarm_page_write").annotations.readOnlyHint, false);
  assert.equal(tools.get("swarm_message_send").annotations.idempotentHint, true);
});

test("a tool validates its input before calling the swarm", async () => {
  const [calls, call] = recorder();
  const tools = new Map(toolsFor(call).map((tool) => [tool.name, tool]));
  await assert.rejects(() => tools.get("swarm_page_write").run({ id: "decisions/api" }), /Missing title/);
  await assert.rejects(() => tools.get("swarm_page_write").run({ id: "BAD", title: "t", body: "b", expectedRevision: 0 }), /lowercase page path/);
  assert.equal(calls.length, 0);

  await tools.get("swarm_page_write").run({ id: "decisions/api", title: "API", body: "text", expectedRevision: 2 });
  assert.deepEqual(calls[0], {
    path: "wiki",
    body: { id: "decisions/api", title: "API", body: "text", expectedRevision: 2, sources: [] },
  });
});

test("the schema offered to a model matches what the tool accepts", () => {
  const [, call] = recorder();
  const write = toolsFor(call).find((tool) => tool.name === "swarm_page_write");
  assert.deepEqual(write.inputSchema.required, ["id", "title", "body", "expectedRevision"]);
  assert.equal(write.inputSchema.additionalProperties, false);
  assert.equal(write.inputSchema.properties.body.maxLength, 16000);
});

test("the server instructions say what the connection does and does not grant", () => {
  assert.match(INSTRUCTIONS, /swarm_context/);
  assert.match(INSTRUCTIONS, /untrusted collaboration data/);
  assert.match(INSTRUCTIONS, /launches no models/);
});
