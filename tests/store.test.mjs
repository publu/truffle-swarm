import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson, openStore, withLock, listProfiles } from "../plugins/truffle-swarm/lib/store.mjs";
import { scratch } from "./helpers/swarm-server.mjs";

test("a missing file reads as nothing saved, and malformed JSON says so", async () => {
  const base = await scratch("store");
  assert.equal(await readJson(join(base, "absent.json")), null);
  await writeFile(join(base, "broken.json"), "{oops");
  await assert.rejects(() => readJson(join(base, "broken.json")), /not valid JSON/);
});

test("credentials are written atomically and only readable by their owner", async () => {
  const base = await scratch("store");
  const path = join(base, "deep", "identity.json");
  await writeJson(path, { token: "secret" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeJson(path, { token: "rotated" });
  assert.deepEqual(await readJson(path), { token: "rotated" });
  assert.equal((await readFile(path, "utf8")).at(-1), "\n");
});

test("the store ignores itself so it cannot be committed by accident", async () => {
  const base = await openStore(await scratch("store"));
  assert.equal(await readFile(join(base, ".gitignore"), "utf8"), "*\n");
  await openStore(base);
  assert.equal(await readFile(join(base, ".gitignore"), "utf8"), "*\n");
});

test("a lock keeps a second writer out and is released afterwards", async () => {
  const base = await scratch("store");
  const path = join(base, "profiles.json");
  let inside = false;
  await withLock(path, async () => {
    inside = true;
    await assert.rejects(() => withLock(path, async () => "second"), /is in progress/);
  });
  assert.equal(inside, true);
  assert.equal(await withLock(path, async () => "free"), "free");
});

test("a lock is released even when the work throws", async () => {
  const base = await scratch("store");
  const path = join(base, "profiles.json");
  await assert.rejects(() => withLock(path, async () => { throw Error("boom"); }), /boom/);
  assert.equal(await withLock(path, async () => "free"), "free");
});

test("profiles are listed from the store, and an empty store is not an error", async () => {
  const base = await scratch("store");
  assert.deepEqual(await listProfiles(base), []);
  await writeJson(join(base, "profiles", "backend.json"), { connections: {} });
  await writeJson(join(base, "profiles", "reviewer.json"), { connections: {} });
  assert.deepEqual(await listProfiles(base), ["backend", "reviewer"]);
});
