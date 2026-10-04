import { join, resolve } from "node:path";
import { readJson, writeJson, withLock, openStore } from "./store.mjs";
import { parseSwarmLink } from "./url.mjs";

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ALIAS = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * A profile's connections: which swarms this bot has joined, under which local
 * alias, and where each identity file lives. Connections are kept in the
 * operator's store, never inside the installed plugin, so updating the plugin
 * cannot touch a credential.
 */
export class Registry {
  constructor(base, profile) {
    if (!PROFILE.test(profile))
      throw Error("Use a simple profile name such as backend or reviewer.");
    this.base = resolve(base);
    this.profile = profile;
    this.path = join(this.base, "profiles", `${profile}.json`);
  }

  async load() {
    const saved = await readJson(this.path);
    this.connections = saved?.connections ?? {};
    return this;
  }

  /** Mutate the registry under a lock, re-reading so a concurrent edit is kept. */
  async update(change) {
    await openStore(this.base);
    return withLock(this.path, async () => {
      const saved = (await readJson(this.path)) ?? { version: 1, connections: {} };
      saved.connections ??= {};
      const result = await change(saved.connections);
      saved.version = 1;
      saved.profile = this.profile;
      await writeJson(this.path, saved);
      this.connections = saved.connections;
      return result;
    });
  }

  list() {
    return Object.entries(this.connections ?? {}).map(([alias, connection]) => ({
      alias,
      swarm: connection.swarm,
      name: connection.name,
      configured: Boolean(connection.automation),
    }));
  }

  has(alias) {
    return Object.hasOwn(this.connections ?? {}, alias);
  }

  get(alias) {
    if (!this.has(alias)) throw Error(`No connection named ${alias}. Run workspaces to see the saved ones.`);
    return this.connections[alias];
  }

  /**
   * Choose the connection an action applies to. With several connected swarms an
   * explicit alias is required: a misdirected post is public and cannot be taken back.
   */
  select(requested) {
    const entries = Object.keys(this.connections ?? {});
    if (requested) {
      if (!this.has(requested)) throw Error(`No connection named ${requested}. Run workspaces to see the saved ones.`);
      return { alias: requested, connection: this.connections[requested] };
    }
    if (entries.length === 1) return { alias: entries[0], connection: this.connections[entries[0]] };
    throw Error(
      entries.length
        ? "Several swarms are connected. Name one with --workspace ALIAS."
        : "No swarms connected yet. Run connect first.",
    );
  }

  /** Where a new identity file for this alias belongs. */
  identityPath(alias, stamp) {
    return join(this.base, "identities", `${this.profile}-${alias}${stamp ? `-${stamp}` : ""}.json`);
  }
}

/** Validate an alias and the swarm it is about to point at. */
export function checkAlias(alias) {
  if (!alias || !ALIAS.test(alias))
    throw Error("Choose a short local alias such as product or research.");
  return alias;
}

/** Refuse to repoint an existing alias at a different swarm. */
export function assertSameSwarm(existing, link) {
  const target = parseSwarmLink(link);
  if (existing && existing.swarm !== target.url)
    throw Error(
      `${existing.swarm} is already saved under this alias. Choose a new alias for ${target.url}.`,
    );
  return target;
}
