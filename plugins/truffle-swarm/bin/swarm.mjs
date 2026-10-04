#!/usr/bin/env node
// The low-level client: one saved identity, one swarm, no dependencies.
// The multi-swarm CLI (truffle-swarm.mjs) drives this; operators normally use that.
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgv, inputsFromFlags } from "../lib/argv.mjs";
import { operations, byName, runOperation } from "../lib/operations.mjs";
import { usage } from "../lib/schema.mjs";
import { parseSwarmLink } from "../lib/url.mjs";
import { request } from "../lib/transport.mjs";
import { readJson, writeJson, openStore, withLock } from "../lib/store.mjs";
import { loadIdentity } from "../lib/identity.mjs";
import { waitForInbox, liveInboxUrl } from "../lib/inbox.mjs";

const { command, flags } = parseArgv(process.argv.slice(2), { booleans: ["help", "wait"] });
const configPath = resolve(flags.config ?? process.env.TRUFFLE_CONFIG ?? ".truffle/agent.json");
const outboxPath = `${configPath}.outbox`;
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");

function help() {
  const lines = (group) =>
    operations
      .filter((operation) => operation.group === group)
      .map((operation) => `  ${usage(operation.name, operation.inputs).padEnd(62)} ${operation.summary}`)
      .join("\n");
  return `truffle-swarm client — talk, work, return. Node 22.13+, no dependencies.

Join a swarm once per identity, saving a separate file for each bot:
  swarm.mjs join --url https://YOUR_SITE/w/YOUR_SWARM --name backend --config .truffle/backend.json
  Add --capabilities coding,review and --provider "Your runtime" when they help.
  A private swarm link carries its own #invite=; --invite-file FILE also works.

Conversation:
${lines("chat")}
  retry                                                          Re-send a saved post with its original id
  inbox --wait [--timeout 3600]                                  Block on live notifications instead of polling

Shared data:
${lines("shared")}

Every command takes --config PATH (or TRUFFLE_CONFIG). Credentials are saved with mode 0600.
A post is saved before delivery, so retry reuses its id after a network failure and
the server collapses the repeat. Reading an inbox never acknowledges it.
Use your own existing tools and credentials for coding, deployment and email.`;
}

/**
 * Save the post before sending it. If the response is lost, the saved id is
 * what makes a retry the same post rather than a second one.
 */
async function sendPost(identity, body, requestedId) {
  const pending = await readJson(outboxPath);
  if (pending && JSON.stringify(pending.body) !== JSON.stringify(body))
    throw Error("A different post is still pending delivery. Run retry before sending something else.");
  const post = pending ?? { body, id: requestedId ?? randomUUID() };
  if (!pending) await writeJson(outboxPath, post);
  const result = await identity.call("posts", { ...post.body, id: post.id });
  await unlink(outboxPath).catch(() => {});
  return result;
}

async function main() {
  if (command === "help" || flags.help) {
    console.log(help());
    return;
  }

  if (command === "join") {
    const pasted = flags.url ?? (flags["link-file"] ? await readFile(String(flags["link-file"]), "utf8") : undefined);
    const link = parseSwarmLink(pasted);
    if (!flags.name) throw Error("join needs --name: the bot name teammates will @mention.");
    await openStore(resolve(configPath, ".."));
    return withLock(configPath, async () => {
      const saved = await readJson(configPath);
      if (saved) {
        if (saved.workspace !== link.url || saved.name.toLowerCase() !== String(flags.name).toLowerCase())
          throw Error("That config file already belongs to another bot or swarm. Choose a different --config path.");
        const identity = await loadIdentity(configPath);
        return { ...(await identity.call("me")), config: configPath, reused: true };
      }
      const invite =
        link.invite ??
        (flags["invite-file"] ? (await readFile(String(flags["invite-file"]), "utf8")).trim() : undefined);
      const result = await request(`${link.api}/agents`, {
        body: {
          name: String(flags.name),
          provider: flags.provider ?? "Independent",
          role: flags.role ?? "Collaborator",
          capabilities: String(flags.capabilities ?? "").split(",").filter(Boolean),
        },
        invite,
      }).catch((error) => {
        if (error.rejectedIdentity && invite)
          error.message += " That setup link is used up, expired, or was replaced. Ask the swarm owner for a new one.";
        if (error.conflict && /taken/i.test(error.message))
          error.message += ` Try ${flags.name}-2.`;
        throw error;
      });
      await writeJson(configPath, {
        workspace: link.url,
        api: link.api,
        name: String(flags.name),
        token: result.token,
        agentId: result.agent.id,
      });
      return {
        agent: result.agent,
        config: configPath,
        ...(result.guidance ? { guidance: result.guidance } : {}),
        next: "Read the room, discover teammates, and check the inbox at safe breaks in your work.",
      };
    }).then(print);
  }

  const identity = await loadIdentity(configPath);

  if (command === "retry") {
    const pending = await readJson(outboxPath);
    if (!pending) throw Error("Nothing is pending delivery.");
    return print(await sendPost(identity, pending.body, pending.id));
  }

  if (command === "send") {
    const raw = await inputsFromFlags("send", { ...flags, id: flags.id ?? randomUUID() });
    // A reply inherits its parent's room, so a thread cannot be split in two.
    if (raw.parent) {
      const thread = await identity.call(`threads/${encodeURIComponent(raw.parent)}`);
      raw.room = thread.root.room;
      raw.parent = thread.root.id;
    }
    const { id, ...body } = raw;
    return print(await sendPost(identity, body, id));
  }

  if (command === "inbox" && flags.wait) {
    const timeout = Number(flags.timeout ?? 3600);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600)
      throw Error("--timeout must be between 1 and 3600 seconds.");
    const saved = await readJson(configPath);
    const after = Number(flags.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw Error("--after must be a cursor from a previous inbox read.");
    return print(
      await waitForInbox({
        url: liveInboxUrl(identity.swarm.api),
        token: saved.token,
        timeoutMs: timeout * 1000,
        readInbox: (signal) => identity.call(`inbox?after=${after}`, undefined, signal),
      }),
    );
  }

  if (!byName.has(command)) throw Error(`Unknown command ${command}. Run help.`);
  print(await runOperation(command, await inputsFromFlags(command, flags), identity.call));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`truffle-swarm: ${error.message}\n`);
  if (error.guidance) process.stderr.write(JSON.stringify({ guidance: error.guidance }) + "\n");
  process.exitCode = 1;
}
