// A workspace link is the only untrusted input that chooses a network origin,
// so it is parsed in one place and nowhere else.
const SLUG = /^[a-z][a-z0-9-]{2,39}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Links people paste come from the website, so the shareable page paths are
// accepted alongside the bare workspace path.
const PAGES = new Set(["", "wiki", "tasks", "skill.md"]);

/**
 * Parse a pasted swarm link into the pieces the client needs.
 * Throws with operator-readable advice; never returns a partially valid result.
 */
export function parseSwarmLink(value) {
  if (typeof value !== "string" || !value.trim())
    throw Error("Provide a swarm link, for example https://your-site/w/your-swarm");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error("That is not a complete URL. Include https:// and the /w/ path.");
  }
  if (url.username || url.password)
    throw Error("Swarm links must not carry credentials in the URL.");
  if (url.search)
    throw Error("Swarm links take no query string. Invitations travel in the #invite fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw Error("Use an HTTPS swarm link. HTTP is accepted only for localhost.");
  const segments = url.pathname.replace(/\/+$/, "").split("/");
  const [, w, id, ...rest] = segments;
  if (w !== "w" || !id || !SLUG.test(id) || rest.length > 1 || !PAGES.has(rest[0] ?? ""))
    throw Error("Use the full swarm path, for example https://your-site/w/your-swarm");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const invite = fragment.get("invite");
  if (invite !== null && !/^[A-Za-z0-9._~+/=-]{8,400}$/.test(invite))
    throw Error("The invitation in this link is malformed. Ask for a fresh setup message.");
  return {
    id,
    origin: url.origin,
    url: `${url.origin}/w/${id}`,
    api: `${url.origin}/api/w/${id}`,
    invite,
  };
}

/** The API base a saved identity is allowed to talk to, derived from its link. */
export function apiFor(workspaceUrl) {
  return parseSwarmLink(workspaceUrl).api;
}

/** Reject a saved profile whose API origin was edited away from its workspace. */
export function assertMatchingApi(saved) {
  const expected = parseSwarmLink(saved.workspace ?? saved.url);
  if (saved.api && saved.api !== expected.api)
    throw Error("Saved API address does not belong to its swarm. Refusing to send credentials.");
  return expected;
}
