import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  advanceJob,
  parseListenOptions,
  queueEvents,
  queueReadyTasks,
  listenerStatus,
  retryJob,
  settingsToArgs,
} from "../plugins/truffle-swarm/lib/connector.mjs";
import { TurnBudget } from "../plugins/truffle-swarm/lib/policy.mjs";
import { SwarmError } from "../plugins/truffle-swarm/lib/errors.mjs";
import { writeJson } from "../plugins/truffle-swarm/lib/store.mjs";
import { NO_REPLY } from "../plugins/truffle-swarm/lib/prompt.mjs";
import { startSwarm, scratch } from "./helpers/swarm-server.mjs";

const settings = {
  runtime: "claude",
  mode: "read",
  allow: ["lead"],
  maxTurns: 20,
  threadLimit: 4,
  turnTimeout: 300,
};
const agents = [{ id: "agent-lead", name: "lead" }, { id: "agent-demo", name: "lead", demo: true }];

const emptyState = () => ({ jobs: {}, threadTurns: {}, turnStamps: [], cursor: 0 });

async function harness({ answer = "Reviewed: looks right.", swarmOptions = {}, override = {} } = {}) {
  const swarm = await startSwarm(swarmOptions);
  const base = await scratch("connector");
  const identityPath = join(base, "backend.json");
  await writeJson(identityPath, { workspace: swarm.url, api: swarm.api, name: "backend", token: swarm.token, agentId: "agent-self" });
  const { loadIdentity } = await import("../plugins/truffle-swarm/lib/identity.mjs");
  const identity = await loadIdentity(identityPath);
  const state = emptyState();
  const turns = [];
  return {
    swarm,
    identity,
    state,
    turns,
    base,
    async advance(job) {
      return advanceJob({
        job,
        state,
        persist: async () => {},
        call: identity.call,
        identity,
        settings: { ...settings, ...override },
        budget: new TurnBudget((override.maxTurns ?? settings.maxTurns)),
        deps: {
          runTurn: async (runtime, options) => {
            turns.push({ runtime, options });
            if (typeof answer === "function") return answer();
            return answer;
          },
        },
      });
    },
  };
}

test("listener options are validated, and work mode requires a project directory", () => {
  const parsed = parseListenOptions(["--runtime", "claude", "--allow-from", "lead,reviewer"]);
  assert.equal(parsed.mode, "read");
  assert.equal(parsed.background, true);
  assert.deepEqual(parsed.allow, ["lead", "reviewer"]);
  assert.throws(() => parseListenOptions(["--allow-from", "lead"]), /Choose --runtime/);
  assert.throws(() => parseListenOptions(["--runtime", "nope", "--allow-from", "lead"]), /Unknown runtime|Choose --runtime/);
  assert.throws(() => parseListenOptions(["--runtime", "claude"]), /Name who may send/);
  assert.throws(() => parseListenOptions(["--runtime", "claude", "--allow-from", "lead", "--mode", "work"]), /needs --directory/);
  assert.throws(() => parseListenOptions(["--runtime", "claude", "--allow-from", "lead", "--max-turns", "0"]), /positive whole number/);
  assert.throws(() => parseListenOptions(["--runtime", "claude", "--allow-from", "lead", "--sudo"]), /Unsupported listener option/);
  assert.equal(parseListenOptions(["--runtime", "claude", "--allow-from", "lead", "--once"]).background, false);
});

test("validated settings round-trip through the saved argument list", () => {
  const parsed = parseListenOptions(["--runtime", "codex", "--mode", "work", "--directory", ".", "--allow-from", "lead", "--max-turns", "5"]);
  assert.deepEqual(parseListenOptions(settingsToArgs(parsed)).allow, ["lead"]);
  assert.equal(parseListenOptions(settingsToArgs(parsed)).maxTurns, 5);
});

test("only authorized senders become jobs; everyone else is skipped once", async () => {
  const state = emptyState();
  const queued = await queueEvents({
    events: [
      { id: 1, actor: "agent-lead", objectId: "m1" },
      { id: 2, actor: "agent-stranger", objectId: "m2" },
      { id: 3, actor: "agent-self", objectId: "m3" },
      { id: 4, actor: "agent-demo", objectId: "m4" },
    ],
    state,
    agents,
    settings,
    agentId: "agent-self",
  });
  assert.deepEqual(queued, [1]);
  assert.equal(state.jobs[2].status, "skipped");
  assert.match(state.jobs[2].reason, /not authorized/);
  assert.equal(state.jobs[3].reason, "Own activity.");
  assert.equal(state.jobs[4].status, "skipped");

  const again = await queueEvents({ events: [{ id: 1, actor: "agent-lead", objectId: "m1" }], state, agents, settings, agentId: "agent-self" });
  assert.deepEqual(again, []);
});

test("a dependency notification queues work only when the task is really ready", async () => {
  const tasks = [
    { id: "schema", status: "done" },
    { id: "api", status: "todo", owner: "agent-self", creator: "agent-lead", dependencies: ["schema"], version: 2 },
    { id: "docs", status: "todo", owner: "agent-other", creator: "agent-lead", dependencies: ["schema"] },
    { id: "ui", status: "todo", owner: "agent-self", creator: "agent-stranger", dependencies: ["schema"] },
  ];
  const state = emptyState();
  const call = async () => ({ tasks });
  const queued = await queueReadyTasks({
    event: { type: "task.updated", objectId: "schema" },
    state,
    call,
    settings,
    agentId: "agent-self",
    agents,
  });
  assert.deepEqual(queued, ["ready:api:2"]);
  assert.equal(state.jobs["ready:api:2"].task, "api");

  assert.deepEqual(
    await queueReadyTasks({ event: { type: "message.created", objectId: "schema" }, state, call, settings, agentId: "agent-self", agents }),
    [],
  );
});

test("a job runs a turn, posts the answer, then acknowledges the event", async () => {
  const { swarm, advance, state, turns } = await harness();
  try {
    const job = { event: { id: 11, actor: "agent-lead", objectId: "root-1" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "done");
    // Re-advancing a finished job repeats nothing.
    await advance(job);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].runtime, "claude");
    assert.match(turns[0].options.prompt, /You are @backend/);
    assert.equal(swarm.data.posts.length, 1);
    assert.equal(swarm.data.posts[0].body, "Reviewed: looks right.");
    assert.equal(swarm.data.posts[0].parent, "root-1");
    assert.deepEqual(swarm.data.acked, [11]);
    assert.equal(state.threadTurns["root-1"], 1);
  } finally {
    await swarm.close();
  }
});

test("an answer is saved before delivery, and a lost response retries the same post id", async () => {
  let attempts = 0;
  const { swarm, advance, turns } = await harness({
    swarmOptions: {
      routes: {
        posts: ({ reply, body, data }) => {
          if (attempts++ === 0) return reply({ error: "gateway" }, 502);
          data.posts.push(body);
          return reply({ post: body }, 201);
        },
      },
    },
  });
  try {
    const job = { event: { id: 12, actor: "agent-lead", objectId: "root-2" }, status: "queued" };
    await advance(job);
    // Delivery failed with an unknown outcome, so the answer is kept, not resent blindly.
    assert.equal(job.status, "uncertain");
    assert.equal(job.answer, "Reviewed: looks right.");
    assert.equal(swarm.data.posts.length, 0);
    assert.equal(swarm.data.acked.length, 0);

    job.status = "answered";
    await advance(job);
    assert.equal(job.status, "done");
    assert.equal(swarm.data.posts.length, 1);
    assert.equal(swarm.data.posts[0].id, job.postId);
    assert.deepEqual(swarm.data.acked, [12]);
    // Exactly one turn: the retry re-delivered the saved answer, it did not re-run.
    assert.equal(turns.length, 1);
  } finally {
    await swarm.close();
  }
});

test("the no-reply sentinel delivers nothing but still clears the event", async () => {
  const { swarm, advance } = await harness({ answer: NO_REPLY });
  try {
    const job = { event: { id: 13, actor: "agent-lead", objectId: "root-3" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "done");
    assert.match(job.reason, /nothing useful to add/);
    assert.equal(swarm.data.posts.length, 0);
    assert.deepEqual(swarm.data.acked, [13]);
  } finally {
    await swarm.close();
  }
});

test("a thread at its bot reply limit blocks instead of answering", async () => {
  const { swarm, advance, state, turns } = await harness();
  try {
    state.threadTurns["root-4"] = 4;
    const job = { event: { id: 14, actor: "agent-bot", objectId: "root-4" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "blocked");
    assert.match(job.error, /bot reply limit/);
    assert.equal(turns.length, 0);
    assert.equal(swarm.data.posts.length, 0);
  } finally {
    await swarm.close();
  }
});

test("a human is answered even in a thread past the bot limit", async () => {
  const { swarm, advance, state } = await harness();
  try {
    state.threadTurns["root-5"] = 9;
    const job = { event: { id: 15, actor: "human-3", objectId: "root-5" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "done");
    assert.equal(swarm.data.posts.length, 1);
  } finally {
    await swarm.close();
  }
});

test("a spent turn budget blocks the job and says when to retry", async () => {
  const { swarm, advance, state, turns } = await harness({ override: { maxTurns: 1 } });
  try {
    state.turnStamps = [Date.now()];
    const job = { event: { id: 16, actor: "agent-lead", objectId: "root-6" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "blocked");
    assert.match(job.error, /Turn budget of 1 per hour/);
    assert.equal(turns.length, 0);
  } finally {
    await swarm.close();
  }
});

test("a runtime that fails blocks the job rather than posting an empty reply", async () => {
  const { swarm, advance } = await harness({
    answer: () => {
      throw Error("Claude Code exceeded its turn timeout.");
    },
  });
  try {
    const job = { event: { id: 17, actor: "agent-lead", objectId: "root-7" }, status: "queued" };
    await advance(job);
    assert.equal(job.status, "blocked");
    assert.match(job.error, /turn timeout/);
    assert.equal(swarm.data.posts.length, 0);
  } finally {
    await swarm.close();
  }
});

test("status reads durable state, and retry only reopens an interrupted job", async () => {
  const base = await scratch("connector-state");
  const identityPath = join(base, "backend.json");
  assert.deepEqual(await listenerStatus(identityPath), { running: false, configured: false });

  await writeJson(`${identityPath}.listener`, {
    pid: null,
    phase: "stopped",
    settings: { runtime: "claude", mode: "read" },
    jobs: {
      21: { event: { id: 21 }, status: "uncertain", error: "stopped mid-turn" },
      22: { event: { id: 22 }, status: "done" },
      23: { event: { id: 23 }, status: "queued" },
    },
  });
  const status = await listenerStatus(identityPath);
  assert.equal(status.running, false);
  assert.equal(status.phase, "stopped");
  assert.equal(status.runtime, "claude");
  assert.deepEqual(status.uncertain, [21]);
  assert.equal(status.pending, 2);
  assert.match(status.log, /\.listener\.log$/);

  const reopened = await retryJob(identityPath, "21");
  assert.deepEqual(reopened.event, "21");
  assert.equal(reopened.status, "queued");
  assert.equal(reopened.attempts, 1);
  await assert.rejects(() => retryJob(identityPath, "22"), /only uncertain or blocked/);
  await assert.rejects(() => retryJob(identityPath, "99"), /No saved job/);
});

test("a swarm error marks delivery uncertain only when it really is", () => {
  assert.equal(new SwarmError("network", 0).uncertain, true);
  assert.equal(new SwarmError("502", 502).uncertain, true);
  assert.equal(new SwarmError("409", 409).uncertain, false);
  assert.equal(new SwarmError("409", 409).conflict, true);
  assert.equal(new SwarmError("401", 401).rejectedIdentity, true);
});
