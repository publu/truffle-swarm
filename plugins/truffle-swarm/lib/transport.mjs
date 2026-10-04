import { SwarmError, readGuidance } from "./errors.mjs";

const TIMEOUT_MS = 30000;

/**
 * One JSON request. Redirects are refused so a credential can never be
 * replayed to an origin the operator never approved.
 */
export async function request(url, { method, body, token, invite, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const deadline = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: verb,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(invite ? { "X-Truffle-Invite": invite } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new SwarmError(
      signal?.aborted
        ? "The request was cancelled."
        : "Cannot reach the swarm. Check the address and your connection; redirects are not followed. A write may still have landed, so read current state before retrying.",
      0,
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json"))
    throw new SwarmError(
      `That address did not answer with the swarm API (HTTP ${response.status}). Check the swarm link.`,
      response.status,
    );
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new SwarmError(`The swarm API returned malformed JSON (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    const revision =
      payload.currentRevision !== undefined ? ` (current revision ${payload.currentRevision})` : "";
    throw new SwarmError(`${response.status}: ${payload.error || "Request failed"}${revision}`, response.status, {
      guidance: readGuidance(payload),
      currentRevision: payload.currentRevision,
      currentVersion: payload.currentVersion,
    });
  }
  return payload;
}

/**
 * Bind a saved identity to its own API prefix. Paths are resolved against that
 * prefix and may not escape it, so an operation name can never redirect a call.
 */
export function apiClient({ api, token, invite }) {
  const base = new URL(api.endsWith("/") ? api : api + "/");
  return async function call(path, body, signal) {
    const target = new URL(String(path).replace(/^\/+/, ""), base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.hash)
      throw Error("Refusing to call outside this swarm's API.");
    return request(target, { body, token, invite, signal });
  };
}
