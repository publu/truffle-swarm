import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { operations, byName, mcpOperations, runOperation } from "../plugins/truffle-swarm/lib/operations.mjs";
import { jsonSchema } from "../plugins/truffle-swarm/lib/schema.mjs";
import { scratch } from "./helpers/swarm-server.mjs";

const recorder = () => {
  const calls = [];
  return [calls, async (path, body) => (calls.push({ path, body }), { ok: true })];
};

test("every operation is named once and declares a summary", () => {
  assert.equal(new Set(operations.map((operation) => operation.name)).size, operations.length);
  for (const operation of operations) {
    assert.ok(operation.summary, operation.name);
    assert.ok(["chat", "shared"].includes(operation.group), operation.name);
    assert.ok(operation.call || operation.run, operation.name);
  }
});

test("every MCP tool has a unique name, a description and a usable schema", () => {
  assert.equal(new Set(mcpOperations.map((operation) => operation.tool)).size, mcpOperations.length);
  for (const operation of mcpOperations) {
    assert.match(operation.tool, /^swarm_[a-z_]+$/);
    assert.ok((operation.description ?? "").length > 40, operation.tool);
    assert.equal(jsonSchema(operation.inputs).type, "object");
  }
});

test("reads are marked read-only and writes are not", () => {
  assert.equal(byName.get("context").readOnly, true);
  assert.equal(byName.get("write").readOnly, undefined);
  assert.equal(byName.get("send").idempotent, true);
  assert.equal(byName.get("export").mcp, false);
});

test("optional query parameters are omitted rather than sent empty", async () => {
  const [calls, call] = recorder();
  await runOperation("context", {}, call);
  await runOperation("context", { task: "api-shape" }, call);
  assert.deepEqual(calls.map((entry) => entry.path), ["context", "context?task=api-shape"]);
});

test("a wiki write sends its expected revision as a number", async () => {
  const [calls, call] = recorder();
  await runOperation("write", { id: "decisions/api", title: "API", body: "text", expectedRevision: "0" }, call);
  assert.equal(calls[0].path, "wiki");
  assert.deepEqual(calls[0].body, {
    id: "decisions/api",
    title: "API",
    body: "text",
    expectedRevision: 0,
    sources: [],
  });
});

test("a reply posts into its parent's thread", async () => {
  const [calls, call] = recorder();
  await runOperation("send", { id: "post-1", body: "done", parent: "root-1" }, call);
  assert.deepEqual(calls[0], { path: "posts", body: { id: "post-1", room: "general", body: "done", parent: "root-1" } });
});

test("following and unfollowing a room are separate endpoints", async () => {
  const [calls, call] = recorder();
  await runOperation("follow", { room: "design" }, call);
  await runOperation("follow", { room: "design", follow: "false" }, call);
  assert.deepEqual(calls.map((entry) => entry.path), ["join", "leave"]);
});

test("an unknown operation is refused", async () => {
  const [, call] = recorder();
  await assert.rejects(() => runOperation("deploy", {}, call), /Unknown operation deploy/);
});

test("export pages through the wiki and refuses to overwrite a file", async () => {
  const base = await scratch("export");
  const file = join(base, "wiki.json");
  let page = 0;
  const call = async () =>
    page++ === 0
      ? { version: 7, pages: [{ id: "index" }], hasMore: true, nextAfter: "cursor-1" }
      : { version: 7, pages: [{ id: "decisions/api" }], hasMore: false };
  const result = await runOperation("export", { file }, call);
  assert.deepEqual(result, { exported: 2, file, version: 7 });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.format, "truffle.wiki.v1");
  assert.equal(saved.pages.length, 2);
  page = 0;
  await assert.rejects(() => runOperation("export", { file }, call), /EEXIST/);
  await rm(file);
});
