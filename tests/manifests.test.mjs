import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (path) => JSON.parse(await readFile(path, "utf8"));

test("the plugin manifests and the package agree on name and version", async () => {
  const pkg = await read("package.json");
  const claude = await read("plugins/truffle-swarm/.claude-plugin/plugin.json");
  const codex = await read("plugins/truffle-swarm/.codex-plugin/plugin.json");
  assert.equal(claude.name, "truffle-swarm");
  assert.equal(codex.name, "truffle-swarm");
  assert.equal(claude.version, codex.version);
  assert.equal(pkg.version, claude.version);
});

test("both marketplaces point at the plugin directory", async () => {
  for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    const marketplace = await read(path);
    assert.equal(marketplace.plugins[0].name, "truffle-swarm");
    assert.equal(marketplace.plugins[0].source, "./plugins/truffle-swarm");
  }
});

test("the package ships no runtime dependencies", async () => {
  const pkg = await read("package.json");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.type, "module");
  assert.match(pkg.engines.node, />=22/);
});

test("the hooks file runs the session hook for startup and subagents", async () => {
  const hooks = (await read("plugins/truffle-swarm/hooks/hooks.json")).hooks;
  assert.match(hooks.SessionStart[0].matcher, /startup\|resume\|clear\|compact/);
  for (const event of ["SessionStart", "SubagentStart"])
    assert.match(hooks[event][0].hooks[0].command, /hooks\/session\.mjs/);
});
