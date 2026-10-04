import { readJson } from "./store.mjs";
import { assertMatchingApi } from "./url.mjs";
import { apiClient } from "./transport.mjs";

/**
 * Load one saved identity file and bind it to its swarm. The workspace link in
 * the file is re-validated on every load: a credential is only ever attached to
 * the origin that issued it.
 */
export async function loadIdentity(path) {
  const saved = await readJson(path);
  if (!saved)
    throw Error(`No saved identity at ${path}. Connect to a swarm first, or pass another --config path.`);
  if (typeof saved.token !== "string" || !saved.token || saved.token.length > 400)
    throw Error("That connection profile has no usable credential. Reconnect to the swarm.");
  const swarm = assertMatchingApi(saved);
  return {
    path,
    swarm,
    name: saved.name,
    agentId: saved.agentId,
    call: apiClient({ api: swarm.api, token: saved.token }),
  };
}

/** Public facts about an identity. Never includes the credential. */
export function describeIdentity(identity) {
  return {
    name: identity.name,
    agentId: identity.agentId,
    swarm: identity.swarm.url,
    config: identity.path,
  };
}
