import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setup, setupTargets } from "../plugins/truffle-swarm/lib/setup.mjs";
import { scratch } from "./helpers/swarm-server.mjs";

test("the supported targets are named, and anything else is refused", async () => {
  assert.deepEqual(setupTargets, ["claude", "codex", "kimi", "hermes"]);
  await assert.rejects(() => setup({ target: "emacs", global: true }), /Use --target claude, codex, kimi, hermes/);
});

test("the portable skill is installed privately into a project directory", async () => {
  const base = await scratch("setup");
  const result = await setup({ target: "kimi", directory: base });
  assert.equal(result.installed, true);
  assert.equal(result.updated, false);
  assert.equal(result.skill, join(base, ".agents", "skills", "truffle-swarm", "SKILL.md"));
  const body = await readFile(result.skill, "utf8");
  assert.match(body, /Installed by truffle-swarm setup/);
  assert.match(body, /name: collaborate/);
  assert.equal((await stat(result.skill)).mode & 0o777, 0o600);
});

test("reinstalling updates the copy this tool wrote", async () => {
  const base = await scratch("setup");
  await setup({ target: "kimi", directory: base });
  const again = await setup({ target: "kimi", directory: base });
  assert.equal(again.installed, true);
  assert.equal(again.updated, true);
});

test("another integration's skill file is reported, never overwritten", async () => {
  const base = await scratch("setup");
  const path = join(base, ".agents", "skills", "truffle-swarm");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "someone else's skill\n");
  const result = await setup({ target: "kimi", directory: base });
  assert.equal(result.installed, false);
  assert.match(result.detail, /Move it aside/);
  assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), "someone else's skill\n");
});

test("writing through a symlinked skill directory is refused", async () => {
  const base = await scratch("setup");
  const elsewhere = await scratch("setup-target");
  await mkdir(join(base, ".agents", "skills"), { recursive: true });
  await symlink(elsewhere, join(base, ".agents", "skills", "truffle-swarm"));
  await assert.rejects(() => setup({ target: "kimi", directory: base }), /Refusing to write through the symlinked path/);
});

test("global and directory are mutually exclusive, and hermes is global only", async () => {
  const base = await scratch("setup");
  await assert.rejects(() => setup({ target: "kimi", directory: base, global: true }), /Choose --global or --directory/);
  await assert.rejects(() => setup({ target: "hermes", directory: base }), /setup --target hermes --global/);
});

test("installing for a native runtime says the plugin is the normal route", async () => {
  const base = await scratch("setup");
  const result = await setup({ target: "claude", directory: base });
  assert.match(result.note, /normally installs the native plugin/);
});
