import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSwarm, scratch } from "./helpers/swarm-server.mjs";

const CLI = "plugins/truffle-swarm/bin/truffle-swarm.mjs";

function run(store, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args, "--store", store, "--profile", "backend"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TRUFFLE_NO_UPDATE_CHECK: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        /* help and errors are not JSON */
      }
      done({ code, out, err, json });
    });
  });
}

test("two swarms stay separate, each with its own credential", async () => {
  const store = await scratch("cli");
  const product = await startSwarm({ slug: "product", token: "token-product" });
  const research = await startSwarm({ slug: "research", token: "token-research" });
  try {
    for (const swarm of [product, research]) {
      const joined = await run(store, ["join", swarm.slug, "--url", swarm.url, "--name", "backend"]);
      assert.equal(joined.code, 0, joined.err);
      assert.equal(joined.json.swarm, swarm.url);
    }
    const listed = await run(store, ["workspaces"]);
    assert.deepEqual(listed.json.workspaces.map((entry) => entry.alias), ["product", "research"]);
    assert.ok(!listed.out.includes("token-"));

    const first = JSON.parse(await readFile(join(store, "identities", "backend-product.json"), "utf8"));
    const second = JSON.parse(await readFile(join(store, "identities", "backend-research.json"), "utf8"));
    assert.equal(first.token, "token-product");
    assert.equal(second.token, "token-research");
  } finally {
    await product.close();
    await research.close();
  }
});

test("an ambiguous action is refused rather than sent to the wrong swarm", async () => {
  const store = await scratch("cli");
  const product = await startSwarm({ slug: "product", token: "token-product" });
  const research = await startSwarm({ slug: "research", token: "token-research" });
  try {
    for (const swarm of [product, research])
      await run(store, ["join", swarm.slug, "--url", swarm.url, "--name", "backend"]);
    const ambiguous = await run(store, ["send", "--body", "hello"]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.err, /--workspace ALIAS/);
    assert.equal(product.data.posts.length, 0);
    assert.equal(research.data.posts.length, 0);

    const directed = await run(store, ["send", "--workspace", "research", "--body", "hello"]);
    assert.equal(directed.code, 0, directed.err);
    assert.equal(research.data.posts.length, 1);
    assert.equal(product.data.posts.length, 0);
  } finally {
    await product.close();
    await research.close();
  }
});

test("an alias cannot be repointed at a different swarm", async () => {
  const store = await scratch("cli");
  const product = await startSwarm({ slug: "product" });
  const other = await startSwarm({ slug: "other", token: "token-other" });
  try {
    await run(store, ["join", "product", "--url", product.url, "--name", "backend"]);
    const moved = await run(store, ["join", "product", "--url", other.url, "--name", "backend"]);
    assert.equal(moved.code, 1);
    assert.match(moved.err, /Choose a new alias/);
  } finally {
    await product.close();
    await other.close();
  }
});

test("a second bot in one project needs its own profile", async () => {
  const store = await scratch("cli");
  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const clash = await run(store, ["join", "product", "--url", swarm.url, "--name", "reviewer"]);
    assert.equal(clash.code, 1);
    assert.match(clash.err, /already connects @backend/);
  } finally {
    await swarm.close();
  }
});

test("onboard reports what is saved and what is missing, without starting anything", async () => {
  const store = await scratch("cli");
  const empty = await run(store, ["onboard"]);
  assert.equal(empty.json.workspaces.length, 0);
  assert.match(empty.json.next, /Ask which swarm to join/);

  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const joined = await run(store, ["onboard"]);
    assert.equal(joined.json.workspaces[0].alias, "product");
    assert.equal(joined.json.workspaces[0].joined, true);
    assert.equal(joined.json.workspaces[0].running, false);
    assert.equal(joined.json.workspaces[0].configured, false);
    assert.match(joined.json.next, /Leave stopped connections stopped/);
  } finally {
    await swarm.close();
  }
});

test("shared data commands reach the selected swarm with its own token", async () => {
  const store = await scratch("cli");
  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const context = await run(store, ["context", "--task", "api-shape"]);
    assert.equal(context.code, 0, context.err);
    const call = swarm.calls.find((entry) => entry.path === "context");
    assert.deepEqual(call.query, { task: "api-shape" });
    assert.equal(call.auth, `Bearer ${swarm.token}`);
  } finally {
    await swarm.close();
  }
});

test("mcp-config points at this identity and never prints its token", async () => {
  const store = await scratch("cli");
  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const result = await run(store, ["mcp-config"]);
    const server = result.json.mcpServers["truffle-swarm"];
    assert.match(server.args[0], /swarm-mcp\.mjs$/);
    assert.equal(server.args[1], "--config");
    assert.ok(!result.out.includes(swarm.token));
  } finally {
    await swarm.close();
  }
});

test("a waiting inbox is refused in the operator's terminal", async () => {
  const store = await scratch("cli");
  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const waited = await run(store, ["inbox", "--wait"]);
    assert.equal(waited.code, 1);
    assert.match(waited.err, /answers immediately here/);
  } finally {
    await swarm.close();
  }
});

test("resume refuses a connection that was never activated", async () => {
  const store = await scratch("cli");
  const swarm = await startSwarm();
  try {
    await run(store, ["join", "product", "--url", swarm.url, "--name", "backend"]);
    const resumed = await run(store, ["resume"]);
    assert.equal(resumed.code, 1);
    assert.match(resumed.err, /never been activated/);
  } finally {
    await swarm.close();
  }
});

test("help lists the lifecycle commands and needs no connection", async () => {
  const store = await scratch("cli");
  const result = await run(store, ["help"]);
  assert.equal(result.code, 0);
  for (const command of ["join", "activate", "pause", "resume", "listener-retry", "onboard"])
    assert.match(result.out, new RegExp(command));
});
