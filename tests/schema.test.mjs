import test from "node:test";
import assert from "node:assert/strict";
import { field, validate, jsonSchema, usage } from "../plugins/truffle-swarm/lib/schema.mjs";

const inputs = {
  id: field("page", { required: true }),
  revision: field("integer", { min: 0, required: true, flag: "revision" }),
  status: field("enum", { values: ["todo", "done"], default: "todo" }),
  sources: field("url", { list: true, max: 2, default: [] }),
  note: field("string", { max: 5 }),
};

test("values are coerced and defaults applied", () => {
  const result = validate(inputs, { id: "decisions/api", revision: "4", sources: "https://a.example,https://b.example" });
  assert.deepEqual(result, {
    id: "decisions/api",
    revision: 4,
    status: "todo",
    sources: ["https://a.example", "https://b.example"],
  });
});

test("each constraint is reported with the field that broke it", () => {
  assert.throws(() => validate(inputs, { revision: 1 }), /Missing id/);
  assert.throws(() => validate(inputs, { id: "Decisions/API", revision: 1 }), /^Error: id: must be a lowercase page path/);
  assert.throws(() => validate(inputs, { id: "a", revision: "1.5" }), /revision: must be a whole number/);
  assert.throws(() => validate(inputs, { id: "a", revision: -1 }), /revision: must be at least 0/);
  assert.throws(() => validate(inputs, { id: "a", revision: 1, status: "shipped" }), /status: must be one of todo, done/);
  assert.throws(() => validate(inputs, { id: "a", revision: 1, note: "too long" }), /note: must be 5 characters or fewer/);
  assert.throws(() => validate(inputs, { id: "a", revision: 1, sources: "ftp://x" }), /sources: must be an http/);
  assert.throws(() => validate(inputs, { id: "a", revision: 1, sources: ["https://a", "https://b", "https://c"] }), /at most 2/);
});

test("unknown options are refused instead of ignored", () => {
  assert.throws(() => validate(inputs, { id: "a", revision: 1, oops: 1 }), /Unknown option oops/);
});

test("the same declaration produces a JSON Schema for MCP", () => {
  const schema = jsonSchema(inputs);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["id", "revision"]);
  assert.deepEqual(schema.properties.status, { type: "string", enum: ["todo", "done"], default: "todo" });
  assert.equal(schema.properties.sources.type, "array");
  assert.equal(schema.properties.sources.maxItems, 2);
  assert.equal(schema.properties.revision.minimum, 0);
});

test("usage lines mark required flags and honour flag aliases", () => {
  assert.equal(usage("write", inputs), "write --id ID --revision REVISION [--status STATUS] [--sources SOURCES] [--note NOTE]");
});
