import test from "node:test";
import assert from "node:assert/strict";
import {
  TurnBudget,
  allowedSender,
  parseAllowList,
  readyTask,
  replyId,
  withinThreadBudget,
} from "../plugins/truffle-swarm/lib/policy.mjs";

const agents = [
  { id: "agent-lead", name: "lead" },
  { id: "agent-demo", name: "reviewer", demo: true },
];

test("a reply id is stable per event and distinct per identity", () => {
  const a = replyId("https://host/api/w/p", "agent-self", "42");
  assert.equal(a, replyId("https://host/api/w/p", "agent-self", "42"));
  assert.notEqual(a, replyId("https://host/api/w/p", "agent-other", "42"));
  assert.notEqual(a, replyId("https://host/api/w/q", "agent-self", "42"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("an allow list is explicit and deduplicated", () => {
  assert.deepEqual(parseAllowList(["lead,reviewer", " lead "]), ["lead", "reviewer"]);
  assert.throws(() => parseAllowList([]), /Name who may send/);
  assert.throws(() => parseAllowList([" , "]), /Name who may send/);
});

test("ids, registered names and an explicit humans choice authorize a sender", () => {
  assert.equal(allowedSender({ actor: "agent-lead" }, agents, ["agent-lead"]), true);
  assert.equal(allowedSender({ actor: "agent-lead" }, agents, ["lead"]), true);
  assert.equal(allowedSender({ actor: "human-9" }, agents, ["humans"]), true);
  assert.equal(allowedSender({ actor: "account:9" }, agents, ["humans"]), true);
});

test("an unauthorized sender, an empty list, and a demo agent borrowing a name are all refused", () => {
  assert.equal(allowedSender({ actor: "agent-stranger" }, agents, ["lead"]), false);
  assert.equal(allowedSender({ actor: "agent-lead" }, agents, []), false);
  assert.equal(allowedSender({ actor: "agent-demo" }, agents, ["reviewer"]), false);
  assert.equal(allowedSender({ actor: "human-9" }, agents, ["lead"]), false);
});

test("the turn budget is a rolling window that a restart cannot reset", () => {
  const budget = new TurnBudget(2, 1000);
  const now = 10_000;
  assert.equal(budget.check([], now).allowed, true);
  assert.equal(budget.check([now - 10, now - 20], now).allowed, false);
  assert.equal(budget.check([now - 2000, now - 3000], now).stamps.length, 0);
  assert.equal(budget.check([now - 2000, now - 3000], now).allowed, true);
  assert.equal(budget.check([now - 500, now - 400], now).retryAfterMs, 500);
  assert.deepEqual(budget.record([now - 400], now), [now - 400, now]);
});

test("bot-to-bot replies are capped but a human is always answered", () => {
  assert.equal(withinThreadBudget({ actor: "agent-lead", turns: 4, limit: 4 }), false);
  assert.equal(withinThreadBudget({ actor: "agent-lead", turns: 3, limit: 4 }), true);
  assert.equal(withinThreadBudget({ actor: "human-1", turns: 99, limit: 4 }), true);
});

test("a task is ready only when ownership, authorization and every prerequisite hold", () => {
  const tasks = [
    { id: "done-one", status: "done" },
    { id: "open-one", status: "doing" },
  ];
  const base = { tasks, agentId: "agent-self", agents, allow: ["lead"] };
  const task = { id: "next", owner: "agent-self", status: "todo", creator: "agent-lead", dependencies: ["done-one"] };
  assert.equal(readyTask({ ...base, task }), true);
  assert.equal(readyTask({ ...base, task: { ...task, dependencies: ["done-one", "open-one"] } }), false);
  assert.equal(readyTask({ ...base, task: { ...task, owner: "agent-other" } }), false);
  assert.equal(readyTask({ ...base, task: { ...task, status: "doing" } }), false);
  assert.equal(readyTask({ ...base, task: { ...task, creator: "agent-stranger" } }), false);
  assert.equal(readyTask({ ...base, task: undefined }), false);
});
