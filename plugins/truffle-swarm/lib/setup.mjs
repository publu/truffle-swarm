import { readFile, writeFile, mkdir, lstat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MARKER = "<!-- Installed by truffle-swarm setup. -->";

/**
 * Where each runtime looks for a portable skill. Claude Code and Codex install
 * the native plugin instead; they are listed so `setup` can say so rather than
 * silently writing a file the runtime will not read.
 */
const TARGETS = {
  claude: { native: true, home: () => homedir(), parts: [".claude", "skills", "truffle-swarm"] },
  codex: { native: true, home: () => homedir(), parts: [".agents", "skills", "truffle-swarm"] },
  kimi: { home: () => homedir(), parts: [".agents", "skills", "truffle-swarm"] },
  hermes: {
    globalOnly: true,
    home: () => resolve(process.env.HERMES_HOME || join(homedir(), ".hermes")),
    parts: ["skills", "truffle-swarm"],
  },
};

export const setupTargets = Object.keys(TARGETS);

/** Refuse to write through a symlink: it could point at another integration. */
async function assertRealPath(path) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw Error(`Refusing to write through the symlinked path ${path}.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * Install the collaborate skill for a runtime that loads skills from disk.
 * Rewrites only files this tool wrote; anything else is left alone and reported.
 */
export async function setup({ target, directory, global = false }) {
  const spec = TARGETS[target];
  if (!spec)
    throw Error(`Use --target ${setupTargets.join(", ")}. Any other shell-capable agent can call the CLI directly.`);
  if (global && directory) throw Error("Choose --global or --directory, not both.");
  if (spec.globalOnly && !global)
    throw Error(`${target} loads skills from its own profile. Run setup --target ${target} --global.`);

  const source = fileURLToPath(new URL("../skills/collaborate/SKILL.md", import.meta.url));
  const base = global ? spec.home() : resolve(directory || process.cwd());
  await assertRealPath(base);
  let current = base;
  for (const part of spec.parts) {
    current = join(current, part);
    await assertRealPath(current);
  }
  const destination = join(current, "SKILL.md");

  let existing;
  try {
    existing = await readFile(destination, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing !== undefined && !existing.includes(MARKER))
    return {
      target,
      skill: destination,
      installed: false,
      detail: "A different SKILL.md is already installed there. Move it aside, then run setup again.",
    };

  const body = `${MARKER}\n${(await readFile(source, "utf8")).replace(
    "../../lib/",
    "the installed plugin's lib/",
  )}`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temp, body, { mode: 0o600, flag: "wx" });
  await rename(temp, destination);
  return {
    target,
    skill: destination,
    installed: true,
    updated: existing !== undefined,
    ...(spec.native
      ? { note: `${target} normally installs the native plugin; this portable copy is a fallback.` }
      : {}),
    next:
      target === "hermes"
        ? "Run /reload-skills in Hermes, then give it the swarm link."
        : "Start a new session, then give the agent the swarm link.",
  };
}
