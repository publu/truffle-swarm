import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startSwarm, scratch } from "./helpers/swarm-server.mjs";

const CLIENT = "plugins/truffle-swarm/bin/swarm.mjs";

const parse = (out) => {
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
};

function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLIENT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => done({ code, out, err, json: parse(out) }));
  });
}

test("help works with no identity saved", async () => {
  const result = await run(["help"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /talk, work, return/);
  assert.match(result.out, /task-create/);
});

test("joining saves a private identity and reuses it on a repeat", async () => {
  const swarm = await startSwarm();
  const config = join(await scratch("client"), "backend.json");
  try {
    const joined = await run(["join", "--url", `${swarm.url}#invite=invitation-token-1`, "--name", "backend", "--config", config]);
    assert.equal(joined.code, 0, joined.err);
    assert.equal(joined.json.agent.name, "backend");
    const saved = JSON.parse(await readFile(config, "utf8"));
    assert.deepEqual(saved.workspace, swarm.url);
    assert.equal(saved.token, swarm.token);
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal(swarm.calls.filter((call) => call.path === "agents" && call.body).length, 1);

    const again = await run(["join", "--url", swarm.url, "--name", "backend", "--config", config]);
    assert.equal(again.json.reused, true);
    assert.equal(swarm.calls.filter((call) => call.path === "agents" && call.body).length, 1);
  } finally {
    await swarm.close();
  }
});

test("the invitation travels in a header, never in the saved profile", async () => {
  const swarm = await startSwarm();
  const config = join(await scratch("client"), "backend.json");
  try {
    await run(["join", "--url", `${swarm.url}#invite=invitation-token-1`, "--name", "backend", "--config", config]);
    const registration = swarm.calls.find((call) => call.path === "agents" && call.body);
    assert.equal(registration.body.name, "backend");
    assert.ok(!JSON.stringify(await readFile(config, "utf8")).includes("invitation-token-1"));
  } finally {
    await swarm.close();
  }
});

test("a joined config is required before any other command", async () => {
  const config = join(await scratch("client"), "absent.json");
  const result = await run(["me", "--config", config]);
  assert.equal(result.code, 1);
  assert.match(result.err, /No saved identity/);
});

test("a post is saved before delivery and a retry reuses its id", async () => {
  let failures = 1;
  const swarm = await startSwarm({
    routes: {
      posts: ({ reply, body, data }) => {
        if (failures-- > 0) return reply({ error: "upstream unavailable" }, 503);
        data.posts.push(body);
        return reply({ post: body }, 201);
      },
    },
  });
  const config = join(await scratch("client"), "backend.json");
  try {
    await run(["join", "--url", swarm.url, "--name", "backend", "--config", config]);
    const first = await run(["send", "--room", "general", "--body", "result ready", "--config", config]);
    assert.equal(first.code, 1, first.out);
    const pending = JSON.parse(await readFile(`${config}.outbox`, "utf8"));
    assert.equal(pending.body.body, "result ready");

    const retried = await run(["retry", "--config", config]);
    assert.equal(retried.code, 0, retried.err);
    assert.equal(swarm.data.posts.length, 1);
    assert.equal(swarm.data.posts[0].id, pending.id);
    await assert.rejects(() => readFile(`${config}.outbox`, "utf8"), /ENOENT/);
  } finally {
    await swarm.close();
  }
});

test("a different post cannot jump the queue while one is pending", async () => {
  const swarm = await startSwarm({ routes: { posts: ({ reply }) => reply({ error: "down" }, 503) } });
  const config = join(await scratch("client"), "backend.json");
  try {
    await run(["join", "--url", swarm.url, "--name", "backend", "--config", config]);
    await run(["send", "--body", "first", "--config", config]);
    const second = await run(["send", "--body", "second", "--config", config]);
    assert.match(second.err, /Run retry before sending something else/);
  } finally {
    await swarm.close();
  }
});

test("a reply is posted into its parent's room", async () => {
  const swarm = await startSwarm();
  const config = join(await scratch("client"), "backend.json");
  try {
    await run(["join", "--url", swarm.url, "--name", "backend", "--config", config]);
    const result = await run(["send", "--parent", "root-7", "--body", "here is the result", "--config", config]);
    assert.equal(result.code, 0, result.err);
    assert.equal(swarm.data.posts[0].parent, "root-7");
    assert.equal(swarm.data.posts[0].room, "general");
  } finally {
    await swarm.close();
  }
});

test("shared data commands take their declared flags and refuse others", async () => {
  const swarm = await startSwarm();
  const base = await scratch("client");
  const config = join(base, "backend.json");
  try {
    await run(["join", "--url", swarm.url, "--name", "backend", "--config", config]);
    await writeFile(join(base, "page.md"), "# Decision\n");
    const written = await run([
      "write", "--id", "decisions/api", "--title", "API", "--file", join(base, "page.md"),
      "--revision", "4", "--source", "https://example.com/evidence", "--config", config,
    ]);
    assert.equal(written.code, 0, written.err);
    const call = swarm.calls.find((entry) => entry.path === "wiki" && entry.body);
    assert.deepEqual(call.body, {
      id: "decisions/api",
      title: "API",
      body: "# Decision\n",
      expectedRevision: 4,
      sources: ["https://example.com/evidence"],
    });

    const refused = await run(["write", "--id", "decisions/api", "--oops", "1", "--config", config]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /does not take --oops/);
  } finally {
    await swarm.close();
  }
});

test("a credential is never sent to an api edited away from its swarm", async () => {
  const base = await scratch("client");
  const config = join(base, "tampered.json");
  await writeFile(
    config,
    JSON.stringify({ workspace: "https://host/w/product", api: "http://127.0.0.1:1/api/w/product", name: "x", token: "t" }),
  );
  const result = await run(["me", "--config", config]);
  assert.equal(result.code, 1);
  assert.match(result.err, /Refusing to send credentials/);
});
