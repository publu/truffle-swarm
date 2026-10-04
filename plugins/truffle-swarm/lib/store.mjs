import { readFile, writeFile, mkdir, rename, rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const SECRET = 0o600;
const PRIVATE_DIR = 0o700;

/** Read JSON, treating a missing file as "nothing saved yet". */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw Error(`${path} is not valid JSON. Move it aside and reconnect.`);
    throw error;
  }
}

/**
 * Replace a file atomically. A reader either sees the old contents or the new
 * ones, so an interrupted write can never leave a half-written credential.
 */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: SECRET, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Prepare the connection store. Credentials live outside the installed plugin
 * so an update can never move or expose them, and the directory ignores itself
 * in case the operator keeps it inside a repository.
 */
export async function openStore(location) {
  const base = resolve(location);
  await mkdir(base, { recursive: true, mode: PRIVATE_DIR });
  await writeFile(join(base, ".gitignore"), "*\n", { mode: SECRET, flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return base;
}

/**
 * Hold a directory lock while mutating shared state. A stale lock is reported
 * with its path rather than removed, because the other writer may still be alive.
 */
export async function withLock(path, work) {
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: PRIVATE_DIR });
  try {
    await mkdir(lock, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST")
      throw Error(`Another ${path} update is in progress. If nothing is running, remove ${lock} and retry.`);
    throw error;
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** List the profiles saved in a store, for status output. */
export async function listProfiles(base) {
  try {
    return (await readdir(join(base, "profiles")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
