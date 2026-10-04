import test from "node:test";
import assert from "node:assert/strict";
import { boundedContext, boundedThread } from "../plugins/truffle-swarm/lib/context.mjs";

test("bounded context stays valid JSON and names what it dropped", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    id: `task-${index}`,
    title: "x".repeat(200),
    request: "y".repeat(400),
  }));
  const bounded = boundedContext({ actor: "agent-self", tasks }, 4000);
  const encoded = JSON.stringify(bounded);
  assert.ok(encoded.length <= 4000, `was ${encoded.length}`);
  assert.deepEqual(JSON.parse(encoded).tasks[0], tasks[0]);
  assert.ok(bounded.tasks.length < tasks.length);
  const omission = bounded.omitted.find((entry) => entry.section === "tasks");
  assert.equal(omission.count, tasks.length - bounded.tasks.length);
});

test("records are kept whole, never truncated mid-record", () => {
  const bounded = boundedContext({ agents: [{ id: "a", name: "lead", capabilities: ["review"] }] });
  assert.deepEqual(bounded.agents, [{ id: "a", name: "lead", capabilities: ["review"] }]);
});

test("guidance is kept only for the identity it was issued to", () => {
  const guidance = { version: 1, actor: "agent-self", next: "claim the task" };
  assert.deepEqual(boundedContext({ actor: "agent-self", guidance }).guidance, guidance);
  assert.equal(boundedContext({ actor: "agent-other", guidance }).guidance, undefined);
  assert.equal(boundedContext({ actor: "agent-self", guidance: { version: 2, actor: "agent-self" } }).guidance, undefined);
});

test("the triggering message keeps more of its text than its context does", () => {
  const thread = {
    root: { id: "root", author: "agent-lead", body: "r".repeat(5000) },
    replies: [{ id: "trigger", author: "agent-lead", body: "t".repeat(9000) }],
  };
  const [root, trigger] = boundedThread(thread, "trigger");
  assert.equal(root.text.length, 2000);
  assert.equal(root.truncated, true);
  assert.equal(trigger.text.length, 8000);
  assert.equal(trigger.truncated, true);
});

test("an old trigger is carried in alongside the recent tail", () => {
  const replies = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, author: "a", body: "x" }));
  const messages = boundedThread({ root: { id: "root", author: "a", body: "x" }, replies }, "r0");
  assert.ok(messages.some((message) => message.id === "r0"));
  assert.ok(messages.some((message) => message.id === "r29"));
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
});
