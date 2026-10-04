import test from "node:test";
import assert from "node:assert/strict";
import { Registry, checkAlias, assertSameSwarm } from "../plugins/truffle-swarm/lib/registry.mjs";
import { scratch } from "./helpers/swarm-server.mjs";

const load = async (base, profile = "backend") => new Registry(base, profile).load();

test("a profile name must be simple", async () => {
  const base = await scratch("registry");
  assert.throws(() => new Registry(base, "Back End"), /simple profile name/);
  assert.throws(() => new Registry(base, "../escape"), /simple profile name/);
  assert.equal(new Registry(base, "backend").profile, "backend");
});

test("connections survive a reload and keep their identity path", async () => {
  const base = await scratch("registry");
  const registry = await load(base);
  await registry.update((connections) => {
    connections.product = { swarm: "https://host/w/product", name: "backend", config: registry.identityPath("product") };
  });
  const reloaded = await load(base);
  assert.deepEqual(reloaded.list(), [
    { alias: "product", swarm: "https://host/w/product", name: "backend", configured: false },
  ]);
  assert.match(reloaded.get("product").config, /backend-product\.json$/);
});

test("profiles in one store do not see each other's connections", async () => {
  const base = await scratch("registry");
  await (await load(base, "backend")).update((connections) => {
    connections.product = { swarm: "https://host/w/product", name: "backend" };
  });
  assert.deepEqual((await load(base, "reviewer")).list(), []);
});

test("a concurrent update is kept rather than overwritten", async () => {
  const base = await scratch("registry");
  const registry = await load(base);
  await registry.update((connections) => {
    connections.product = { swarm: "https://host/w/product", name: "backend" };
  });
  await (await load(base)).update((connections) => {
    connections.research = { swarm: "https://other/w/research", name: "backend" };
  });
  assert.deepEqual((await load(base)).list().map((entry) => entry.alias), ["product", "research"]);
});

test("one connection is selected implicitly; several require an explicit alias", async () => {
  const base = await scratch("registry");
  const registry = await load(base);
  await assert.throws(() => registry.select(), /No swarms connected/);
  await registry.update((connections) => {
    connections.product = { swarm: "https://host/w/product", name: "backend" };
  });
  assert.equal(registry.select().alias, "product");
  await registry.update((connections) => {
    connections.research = { swarm: "https://other/w/research", name: "backend" };
  });
  assert.throws(() => registry.select(), /--workspace ALIAS/);
  assert.equal(registry.select("research").alias, "research");
  assert.throws(() => registry.select("absent"), /No connection named absent/);
});

test("aliases are local names, and one cannot be repointed at another swarm", () => {
  assert.equal(checkAlias("product"), "product");
  for (const bad of ["", "9lives", "Product", "a", "x".repeat(41)]) assert.throws(() => checkAlias(bad), /short local alias/);
  assert.equal(assertSameSwarm({ swarm: "https://host/w/product" }, "https://host/w/product/wiki").id, "product");
  assert.throws(() => assertSameSwarm({ swarm: "https://host/w/product" }, "https://host/w/other"), /Choose a new alias/);
  assert.equal(assertSameSwarm(null, "https://host/w/other").id, "other");
});
