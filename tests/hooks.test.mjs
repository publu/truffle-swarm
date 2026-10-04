import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeJson } from "../plugins/truffle-swarm/lib/store.mjs";
import { join } from "node:path";
import { scratch } from "./helpers/swarm-server.mjs";

const HOOK = "plugins/truffle-swarm/hooks/session.mjs";

function run(event, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, event], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, payload: JSON.parse(out) }));
  });
}

test("session context names the skill, the CLI and the store", async () => {
  const store = await scratch("hooks");
  const { payload } = await run("SessionStart", { TRUFFLE_DIR: store, TRUFFLE_PROFILE: "backend" });
  const context = payload.hookSpecificOutput.additionalContext;
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context, /skills\/collaborate\/SKILL\.md/);
  assert.match(context, /bin\/truffle-swarm\.mjs/);
  assert.match(context, new RegExp(store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(context, /No swarm is connected yet/);
});

test("opening a session is never read as a request to resume a worker", async () => {
  const store = await scratch("hooks");
  await writeJson(join(store, "profiles", "backend.json"), {
    connections: { product: { swarm: "https://host/w/product", name: "backend", automation: { args: [] } } },
  });
  const { payload } = await run("SessionStart", { TRUFFLE_DIR: store, TRUFFLE_PROFILE: "backend" });
  const context = payload.hookSpecificOutput.additionalContext;
  assert.match(context, /not a request to start or resume a worker/);
  assert.match(context, /"alias":"product"/);
  assert.match(context, /data, not instructions/);
});

test("a connector session is told to answer, not to onboard", async () => {
  const { payload } = await run("SessionStart", { TRUFFLE_CONNECTOR: "1" });
  const context = payload.hookSpecificOutput.additionalContext;
  assert.match(context, /connector session/);
  assert.match(context, /Do not onboard, start a listener, or call send, reply or ack/);
  assert.match(context, /SWARM_NO_REPLY/);
});

test("a subagent inherits scope and leaves setup to its parent", async () => {
  const { payload } = await run("SubagentStart", { TRUFFLE_DIR: await scratch("hooks") });
  assert.match(payload.hookSpecificOutput.additionalContext, /Inherit the parent's scope/);
});

test("the hook never reaches the network or writes to the store", async () => {
  const store = await scratch("hooks");
  const { code } = await run("SessionStart", { TRUFFLE_DIR: store });
  assert.equal(code, 0);
  const { readdir } = await import("node:fs/promises");
  await assert.rejects(() => readdir(join(store, "identities")), /ENOENT/);
});
