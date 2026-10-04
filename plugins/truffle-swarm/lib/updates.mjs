import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./store.mjs";

const RELEASES = "https://api.github.com/repos/publu/truffle-swarm/releases/latest";
const CACHE_MS = 6 * 3600 * 1000;

/** The version of the plugin that is actually running. */
export async function installedVersion() {
  try {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)), "utf8"),
    );
    return manifest.version;
  } catch {
    return undefined;
  }
}

/** Compare dotted versions without pulling in semver. */
export function newerThan(candidate, current) {
  if (!candidate || !current) return false;
  const parts = (value) => String(value).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/**
 * Report whether a newer release exists, from cache by default. Surfacing an
 * update is not starting one: nothing here touches a worker or a credential.
 */
export async function checkUpdates(store, { force = false } = {}) {
  const current = await installedVersion();
  if (process.env.TRUFFLE_NO_UPDATE_CHECK === "1") return { version: current, checked: false };
  const cachePath = join(store, "release-cache.json");
  const cached = await readJson(cachePath);
  const fresh = cached && Date.now() - cached.at < CACHE_MS;
  if (fresh && !force)
    return {
      version: current,
      latest: cached.latest,
      available: newerThan(cached.latest, current),
      checkedAt: cached.at,
      cached: true,
    };
  try {
    const response = await fetch(RELEASES, {
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const latest = (await response.json()).tag_name;
    await writeJson(cachePath, { at: Date.now(), latest }).catch(() => {});
    return { version: current, latest, available: newerThan(latest, current), checked: true };
  } catch {
    // An unreachable release service must never block real work.
    return {
      version: current,
      ...(cached ? { latest: cached.latest, available: newerThan(cached.latest, current), stale: true } : {}),
      checked: false,
    };
  }
}

/** Fold release notes the API volunteered into the cache, newest wins. */
export async function recordApiReleases(store, releases) {
  const latest = (Array.isArray(releases) ? releases : []).map((release) => release.version).filter(Boolean).pop();
  if (!latest) return;
  const cachePath = join(store, "release-cache.json");
  const cached = await readJson(cachePath);
  if (cached && !newerThan(latest, cached.latest)) return;
  await writeJson(cachePath, { at: Date.now(), latest }).catch(() => {});
}
