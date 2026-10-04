#!/usr/bin/env node
// The operator-facing CLI: one client, several swarms, one connection store.
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgv, inputsFromFlags, SELECTORS } from "../lib/argv.mjs";
import { byName, runOperation } from "../lib/operations.mjs";
import { Registry, checkAlias, assertSameSwarm } from "../lib/registry.mjs";
import { loadIdentity } from "../lib/identity.mjs";
import { readJson, openStore } from "../lib/store.mjs";
import { connector, listenerStatus, parseListenOptions, settingsToArgs } from "../lib/connector.mjs";
import { checkUpdates, recordApiReleases, installedVersion } from "../lib/updates.mjs";
import { setup, setupTargets } from "../lib/setup.mjs";
import { probeRuntime, runtimeNames } from "../lib/runtimes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const clientPath = join(here, "swarm.mjs");
const mcpPath = join(here, "swarm-mcp.mjs");

const { command, positional, flags } = parseArgv(process.argv.slice(2), {
  booleans: ["global", "refresh", "background", "foreground", "once", "wait", "follow"],
});
const profile = String(flags.profile ?? process.env.TRUFFLE_PROFILE ?? "default");
const store = resolve(String(flags.store ?? process.env.TRUFFLE_DIR ?? ".truffle"));
const selector = ["--profile", profile, "--store", store];

const LISTENER = ["listen", "listener-status", "listener-stop", "listener-retry"];
const LIFECYCLE = ["activate", "resume", "pause"];

function help() {
  return `truffle-swarm — one client, several swarms.

  setup --target ${setupTargets.join("|")} --global      Install the portable skill for a runtime
  join product --url https://YOUR_SITE/w/product --name backend
  workspaces                                   List saved connections, never credentials
  onboard                                      Report saved setup and what is still missing
  activate --workspace product --runtime ${runtimeNames[0]} --directory PROJECT --allow-from lead
  pause --workspace product                    Stop the worker, keep queued work
  resume --workspace product                   Reuse the saved runtime, project and senders
  listener-status --workspace product
  listener-retry --workspace product --event EVENT_ID
  runtimes                                     Check which runtimes are installed here
  updates [--refresh]                          Report the latest release; changes nothing
  mcp-config --workspace product               Print MCP config for this saved identity
  inbox | read | send | context | pages | tasks | ... --workspace product

listen accepts ${runtimeNames.join(", ")}. The default mode is read; --mode work needs --directory.
--allow-from takes exact sender ids or registered bot names; "humans" explicitly trusts
every human participant. --instructions FILE adds your local policy. --max-turns 20 caps
turns per rolling hour, --thread-limit 4 bounds bot-to-bot replies, --turn-timeout 300
bounds one turn. Listeners run detached and return promptly; --foreground is only for a
dedicated worker process, never the operator's terminal.

Use --profile backend (or TRUFFLE_PROFILE) to keep two bots in one project apart, and
--store /absolute/path/.truffle (or TRUFFLE_DIR) to share connections across directories.
With more than one swarm connected, --workspace ALIAS is required on every action.
Run \`${clientPath} help\` for each shared-data command's own flags.`;
}

/** Run the low-level client in a child process and parse its JSON. */
function runClient(argv) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [clientPath, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (code === 0) done(JSON.parse(out));
      else reject(Error(err.trim().replace(/^truffle-swarm: /, "") || "The client stopped before finishing."));
    });
  });
}

async function joinSwarm(registry) {
  const alias = checkAlias(positional[0]);
  const linkText = flags.url ?? (flags["link-file"] ? (await readFile(String(flags["link-file"]), "utf8")).trim() : undefined);
  if (!linkText) throw Error("join needs --url SWARM_LINK (or --link-file FILE).");
  await openStore(store);
  return registry.update(async (connections) => {
    const existing = connections[alias];
    const link = assertSameSwarm(existing, linkText);
    const imported = flags.config ? resolve(String(flags.config)) : undefined;
    let configPath = existing?.config ?? imported ?? registry.identityPath(alias);
    if (existing && imported && imported !== configPath)
      throw Error("This connection already has a saved identity. Remove the alias before importing another.");
    let saved = await readJson(configPath);
    if (imported && !saved) throw Error(`No identity file at ${imported}.`);
    if (saved && flags.name && saved.name.toLowerCase() !== String(flags.name).toLowerCase())
      throw Error(`Profile ${profile} already connects @${saved.name} to this swarm. Use another --profile for a second bot.`);

    // A fresh invitation after the owner disconnected this bot: the old
    // credential is dead, so join again into a new identity file and keep the
    // saved runtime and sender choices attached to the alias.
    if (saved && link.invite && !imported) {
      const revoked = await runClient(["me", "--config", configPath]).then(
        () => false,
        (error) => /^40[13]:/.test(error.message) || /HTTP 40[13]/.test(error.message),
      );
      if (revoked) {
        configPath = registry.identityPath(alias, Date.now());
        saved = null;
      }
    }

    const name = flags.name ?? saved?.name;
    if (!name) throw Error("Supply --name for a new identity.");
    let inviteFile;
    const extra = [];
    for (const key of ["capabilities", "provider", "role", "invite-file"])
      if (flags[key] !== undefined) extra.push(`--${key}`, String(flags[key]));
    try {
      if (!saved && link.invite) {
        if (flags["invite-file"]) throw Error("Choose an invitation link or --invite-file, not both.");
        inviteFile = join(store, `.invite-${randomUUID()}`);
        await writeFile(inviteFile, link.invite, { mode: 0o600, flag: "wx" });
        extra.push("--invite-file", inviteFile);
      }
      const result = await runClient(["join", "--url", link.url, "--name", String(name), "--config", configPath, ...extra]);
      connections[alias] = { ...existing, swarm: link.url, name: String(name), config: configPath };
      return { joined: alias, swarm: link.url, name: String(name), profile, reused: Boolean(result.reused) };
    } finally {
      if (inviteFile) await rm(inviteFile, { force: true });
    }
  });
}

async function onboard(registry) {
  const workspaces = await Promise.all(
    registry.list().map(async (entry) => {
      const connection = registry.get(entry.alias);
      const identity = await readJson(connection.config);
      return {
        ...entry,
        joined: Boolean(identity),
        ...(identity ? await listenerStatus(connection.config) : { running: false, configured: false }),
      };
    }),
  );
  const settled = workspaces.length && workspaces.every((entry) => entry.running && entry.phase === "waiting");
  return {
    profile,
    store,
    version: await installedVersion(),
    workspaces,
    next: !workspaces.length
      ? "Ask which swarm to join and agree a bot name. Infer the runtime and project directory yourself; they are not questions for the operator."
      : settled
        ? "Connected. Carry on collaborating; do not repeat setup."
        : "Reuse the saved identities. Leave stopped connections stopped unless the operator asks to resume, and keep any resume inside its saved runtime and project scope.",
  };
}

async function lifecycle({ alias, connection, identity, saved }) {
  if (command === "pause")
    return connector({ command: "listener-stop", identity });
  const options =
    command === "resume"
      ? connection.automation?.args
      : Object.keys(flags).some((flag) => !SELECTORS.has(flag)) || positional.length
        ? rebuildListenArgs()
        : undefined;
  if (!options)
    throw Error(
      command === "resume"
        ? "This connection has never been activated. Ask who may send it work, then activate."
        : "activate needs at least --runtime and --allow-from.",
    );
  const settings = parseListenOptions(options);
  if (settings.once) throw Error("activate keeps a worker connected; use listen --once for a single job.");

  const status = await listenerStatus(identity.path);
  if (status.running)
    return { connected: true, alreadyRunning: true, ready: status.ready, phase: status.phase, swarm: connection.swarm };

  const result = await connector({
    command: "listen",
    args: settingsToArgs(settings),
    identity,
    token: saved.token,
    cliPath: selfPath,
    selector: [...selector, "--workspace", alias],
  });
  if (command === "activate")
    // Persist the validated choices outside the plugin so resume, and an
    // update that replaces the plugin, can reproduce them exactly.
    await registryRef.update((connections) => {
      if (connections[alias]?.config !== connection.config)
        throw Error("This connection changed while starting. Check listener-status before continuing.");
      connections[alias].automation = { args: settingsToArgs(settings) };
    });
  return { ...result, swarm: connection.swarm, alias };
}

/** Reassemble listener flags from the parsed argv, preserving repeats. */
function rebuildListenArgs() {
  const args = [];
  for (const [flag, value] of Object.entries(flags)) {
    if (SELECTORS.has(flag)) continue;
    for (const one of Array.isArray(value) ? value : [value])
      args.push(`--${flag}`, ...(one === true ? [] : [String(one)]));
  }
  return args;
}

let registryRef;

async function main() {
  if (command === "help" || flags.help) {
    console.log(help());
    return;
  }
  if (command === "setup")
    return setup({ target: String(flags.target ?? ""), directory: flags.directory, global: Boolean(flags.global) });
  if (command === "updates") return checkUpdates(store, { force: Boolean(flags.refresh) });
  if (command === "runtimes") return { runtimes: await Promise.all(runtimeNames.map(probeRuntime)) };

  const registry = (registryRef = await new Registry(store, profile).load());
  if (command === "join") return joinSwarm(registry);
  if (command === "workspaces") return { profile, store, workspaces: registry.list() };
  if (command === "onboard") return onboard(registry);

  const known = [...LISTENER, ...LIFECYCLE, "mcp-config"];
  if (!known.includes(command) && !byName.has(command)) throw Error(`Unknown command ${command}. Run help.`);

  const { alias, connection } = registry.select(flags.workspace ? String(flags.workspace) : undefined);
  const saved = await readJson(connection.config);
  if (!saved) throw Error(`The identity file for ${alias} is missing. Join that swarm again.`);
  const identity = await loadIdentity(connection.config);

  if (command === "mcp-config")
    return {
      mcpServers: {
        "truffle-swarm": { command: process.execPath, args: [mcpPath, "--config", connection.config] },
      },
    };
  if (LIFECYCLE.includes(command)) return lifecycle({ alias, connection, identity, saved });
  if (LISTENER.includes(command))
    return connector({
      command,
      args: rebuildListenArgs(),
      identity,
      token: saved.token,
      cliPath: selfPath,
      selector: [...selector, "--workspace", alias],
    });
  if (command === "inbox" && flags.wait)
    throw Error("inbox answers immediately here. Use activate or resume for background replies.");

  // Sends go through the client so the durable outbox is honoured.
  if (command === "send")
    return runClient(["send", "--config", connection.config, ...rebuildListenArgs()]);
  return runOperation(command, await inputsFromFlags(command, flags), identity.call);
}

try {
  const result = await main();
  if (result) {
    if (result.releases) await recordApiReleases(store, result.releases);
    if (["onboard", "listener-status", "context", "inbox"].includes(command))
      result.updates = await checkUpdates(store);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  process.stderr.write(`truffle-swarm: ${error.message}\n`);
  process.exitCode = 1;
}
