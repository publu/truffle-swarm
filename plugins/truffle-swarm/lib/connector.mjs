import { spawn } from "node:child_process";
import { readFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./store.mjs";
import { liveInboxUrl, waitForInbox as liveWait } from "./inbox.mjs";
import { runTurn as runRuntimeTurn, probeRuntime, runtimeNames } from "./runtimes.mjs";
import { buildPrompt, NO_REPLY } from "./prompt.mjs";
import {
  TurnBudget,
  allowedSender,
  isHuman,
  parseAllowList,
  readyTask,
  replyId,
  withinThreadBudget,
} from "./policy.mjs";

const clientPath = fileURLToPath(new URL("../bin/swarm.mjs", import.meta.url));
const WAIT_SECONDS = 600;

const statePath = (configPath) => `${configPath}.listener`;
const logPath = (configPath) => `${configPath}.listener.log`;

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

/** Parse the listener flags. Unknown flags are refused rather than ignored. */
export function parseListenOptions(args) {
  const flags = {
    runtime: undefined,
    mode: "read",
    directory: undefined,
    instructions: undefined,
    allow: [],
    maxTurns: 20,
    threadLimit: 4,
    turnTimeout: 300,
    background: true,
    once: false,
  };
  const numbers = { "max-turns": "maxTurns", "thread-limit": "threadLimit", "turn-timeout": "turnTimeout" };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) throw Error(`Missing value for ${arg}.`);
      index++;
      return value;
    };
    switch (arg) {
      case "--runtime":
        flags.runtime = needsValue();
        break;
      case "--mode":
        flags.mode = needsValue();
        break;
      case "--directory":
        flags.directory = resolve(needsValue());
        break;
      case "--instructions":
        flags.instructions = resolve(needsValue());
        break;
      case "--allow-from":
        flags.allow.push(needsValue());
        break;
      case "--background":
        flags.background = true;
        break;
      case "--foreground":
        flags.background = false;
        break;
      case "--once":
        flags.once = true;
        flags.background = false;
        break;
      default: {
        const key = numbers[arg.replace(/^--/, "")];
        if (!key) throw Error(`Unsupported listener option ${arg}.`);
        flags[key] = Number(needsValue());
      }
    }
  }
  if (!runtimeNames.includes(flags.runtime))
    throw Error(`Choose --runtime ${runtimeNames.join(", ")}.`);
  if (!["read", "work"].includes(flags.mode)) throw Error("Choose --mode read or --mode work.");
  if (flags.mode === "work" && !flags.directory)
    throw Error("Work mode needs --directory: the project this bot is allowed to change.");
  for (const [flag, key] of Object.entries(numbers)) {
    const number = flags[key];
    if (!Number.isInteger(number) || number < 1) throw Error(`--${flag} must be a positive whole number.`);
  }
  if (flags.turnTimeout > 3600) throw Error("--turn-timeout must be 3600 seconds or less.");
  flags.allow = parseAllowList(flags.allow);
  return flags;
}

/** Everything status reports, derived from the durable state plus liveness. */
export async function listenerStatus(configPath) {
  const state = await readJson(statePath(configPath));
  if (!state) return { running: false, configured: false };
  const running = alive(state.pid);
  const jobs = Object.values(state.jobs ?? {});
  return {
    running,
    configured: true,
    ready: running && state.phase === "waiting",
    phase: running ? state.phase : "stopped",
    runtime: state.settings?.runtime,
    mode: state.settings?.mode,
    startedAt: state.startedAt,
    pending: jobs.filter((job) => !["done", "skipped"].includes(job.status)).length,
    uncertain: jobs.filter((job) => job.status === "uncertain").map((job) => job.event.id),
    blocked: jobs.filter((job) => job.status === "blocked").map((job) => ({ event: job.event.id, reason: job.error })),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    log: logPath(configPath),
  };
}

export async function stopListener(configPath) {
  const path = statePath(configPath);
  const state = await readJson(path);
  if (!state || !alive(state.pid)) {
    if (state) await writeJson(path, { ...state, pid: null, phase: "stopped" });
    return { stopped: true, wasRunning: false };
  }
  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && alive(state.pid); attempt++)
    await new Promise((done) => setTimeout(done, 100));
  const stillAlive = alive(state.pid);
  await writeJson(path, { ...(await readJson(path)) ?? state, pid: stillAlive ? state.pid : null, phase: stillAlive ? "stopping" : "stopped" });
  return {
    stopped: !stillAlive,
    wasRunning: true,
    ...(stillAlive ? { detail: `Process ${state.pid} has not exited yet. Check again before resuming.` } : {}),
    note: "Queued work is preserved. Uncertain jobs wait for listener-retry.",
  };
}

/** Clear one uncertain job so the next turn may handle its event again. */
export async function retryJob(configPath, eventId) {
  const path = statePath(configPath);
  const state = await readJson(path);
  const job = state?.jobs?.[eventId];
  if (!job) throw Error(`No saved job for event ${eventId}.`);
  if (!["uncertain", "blocked"].includes(job.status))
    throw Error(`Event ${eventId} is ${job.status}; only uncertain or blocked jobs can be retried.`);
  job.status = "queued";
  job.attempts = (job.attempts ?? 0) + 1;
  delete job.error;
  await writeJson(path, state);
  return { event: eventId, status: "queued", attempts: job.attempts, note: "The running listener picks this up on its next pass." };
}

/** Start a detached listener and return as soon as it has a pid. */
async function startBackground({ configPath, cliPath, settings, selector }) {
  const existing = await listenerStatus(configPath);
  if (existing.running)
    return { started: false, alreadyRunning: true, phase: existing.phase, ready: existing.ready };
  const log = await open(logPath(configPath), "a", 0o600);
  const child = spawn(
    process.execPath,
    [cliPath, "listen", ...selector, ...settingsToArgs(settings), "--foreground"],
    { detached: true, stdio: ["ignore", log.fd, log.fd] },
  );
  child.unref();
  await log.close();
  // The child owns the state file; wait briefly for it to claim one.
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await listenerStatus(configPath);
    if (status.running) return { started: true, pid: child.pid, phase: status.phase, log: logPath(configPath) };
    await new Promise((done) => setTimeout(done, 100));
  }
  return {
    started: false,
    pid: child.pid,
    detail: "The listener did not report ready. Read its log before retrying.",
    log: logPath(configPath),
  };
}

export function settingsToArgs(settings) {
  return [
    "--runtime", settings.runtime,
    "--mode", settings.mode,
    ...(settings.directory ? ["--directory", settings.directory] : []),
    ...(settings.instructions ? ["--instructions", settings.instructions] : []),
    ...settings.allow.flatMap((entry) => ["--allow-from", entry]),
    "--max-turns", String(settings.maxTurns),
    "--thread-limit", String(settings.threadLimit),
    "--turn-timeout", String(settings.turnTimeout),
  ];
}

const TERMINAL = new Set(["done", "skipped"]);

/**
 * Turn an inbox page into jobs. Unauthorized senders are recorded as skipped so
 * their events are acknowledged once and never looked at again, and a repeated
 * delivery of the same event never produces a second job.
 */
export async function queueEvents({ events, state, agents, settings, agentId }) {
  const queued = [];
  for (const event of events ?? []) {
    if (state.jobs[event.id]) continue;
    if (event.actor === agentId) {
      state.jobs[event.id] = { event, status: "skipped", reason: "Own activity." };
      continue;
    }
    if (!allowedSender(event, agents, settings.allow)) {
      state.jobs[event.id] = { event, status: "skipped", reason: "Sender is not authorized to send this bot work." };
      continue;
    }
    state.jobs[event.id] = { event, status: "queued", attempts: 0 };
    queued.push(event.id);
  }
  return queued;
}

/**
 * Queue a task whose prerequisites just completed. A dependency notification is
 * only a hint: ownership, authorization and every prerequisite are rechecked
 * against saved state before a model turn is considered.
 */
export async function queueReadyTasks({ event, state, call, settings, agentId, agents }) {
  if (event.type !== "task.updated") return [];
  const { tasks } = await call("tasks");
  if (!tasks.some((task) => task.id === event.objectId && task.status === "done")) return [];
  const queued = [];
  for (const task of tasks) {
    if (!task.dependencies?.includes(event.objectId)) continue;
    if (!readyTask({ task, tasks, agentId, agents, allow: settings.allow })) continue;
    const key = `ready:${task.id}:${task.version ?? 1}`;
    if (state.jobs[key]) continue;
    if (Object.values(state.jobs).some((job) => job.task === task.id && !TERMINAL.has(job.status))) continue;
    state.jobs[key] = {
      event: { ...event, id: key },
      status: "queued",
      attempts: 0,
      task: task.id,
      requester: task.creator,
      ready: true,
    };
    queued.push(key);
  }
  return queued;
}

/** Resolve the thread a job answers, synthesising one for a ready task. */
async function threadFor({ job, call, identity, settings, agents }) {
  if (!job.ready) return call(`threads/${encodeURIComponent(job.event.objectId)}`);
  const { tasks } = await call("tasks");
  const task = tasks.find((one) => one.id === job.task);
  if (
    !readyTask({ task, tasks, agentId: identity.agentId, agents, allow: settings.allow }) ||
    task.creator !== job.requester
  )
    return null;
  if (task.discussion) return call(`threads/${encodeURIComponent(task.discussion)}`);
  return {
    root: {
      id: replyId(identity.swarm.api, identity.agentId, job.event.id),
      room: task.room,
      author: task.creator,
      body: `Task ${task.id} is ready: its prerequisites are done. Read and claim the saved task before working.\n${task.request || task.title}`,
    },
    replies: [],
  };
}

/**
 * Carry one job as far as it can go, persisting after every step. The order
 * matters: the answer is saved before delivery, delivery before acknowledgement.
 * A crash can therefore repeat a delivery — with the same post id, which the
 * server collapses — but can never lose an answer or silently drop an event.
 * Each step is skipped unless the previous one left the job in its input state,
 * so re-advancing a job already past that step is safe.
 */
export async function advanceJob({ job, state, persist, call, identity, settings, deps, budget }) {
  if (job.status === "queued") {
    const agents = (await call("agents")).agents ?? [];
    const thread = await threadFor({ job, call, identity, settings, agents });
    if (!thread) {
      job.status = "skipped";
      job.reason = "The task is no longer authorized and ready. No model turn was started.";
      await persist();
      return job;
    }
    job.root = thread.root.id;
    job.room = thread.root.room;
    if (!withinThreadBudget({ actor: job.event.actor, turns: state.threadTurns[job.root], limit: settings.threadLimit })) {
      job.status = "blocked";
      job.error = "This thread reached its bot reply limit. Review it locally, then listener-retry.";
      await persist();
      return job;
    }
    const window = budget.check(state.turnStamps);
    state.turnStamps = window.stamps;
    if (!window.allowed) {
      job.status = "blocked";
      job.error = `Turn budget of ${settings.maxTurns} per hour is spent. Retry in ${Math.ceil(window.retryAfterMs / 1000)}s.`;
      await persist();
      return job;
    }

    const context = await call(`context${job.task ? `?task=${encodeURIComponent(job.task)}` : ""}`).catch(() => ({}));
    const prompt = buildPrompt({
      thread,
      event: job.event,
      name: identity.name,
      mode: settings.mode,
      instructions: settings.instructionsText,
      context: { ...context, actor: identity.agentId },
      taskTools: { node: process.execPath, client: clientPath, config: identity.path },
    });

    // Mark the turn before running it. If the process dies mid-turn the job is
    // uncertain, and an operator decides whether to repeat side effects.
    job.status = "running";
    state.turnStamps = budget.record(state.turnStamps);
    await persist();
    let answer;
    try {
      answer = await deps.runTurn(settings.runtime, {
        prompt,
        mode: settings.mode,
        cwd: settings.directory,
        timeoutMs: settings.turnTimeout * 1000,
      });
    } catch (error) {
      job.status = "blocked";
      job.error = error.message;
      await persist();
      return job;
    }
    job.answer = answer;
    job.status = answer && answer !== NO_REPLY ? "answered" : "delivered";
    if (job.status === "delivered") job.reason = "The runtime had nothing useful to add.";
    await persist();
  }

  if (job.status === "answered") {
    const postId = replyId(identity.swarm.api, identity.agentId, job.event.id);
    try {
      await call("posts", { id: postId, room: job.room, body: job.answer, parent: job.root });
    } catch (error) {
      // Unknown delivery: the saved post id makes a later retry the same post.
      if (error.uncertain) {
        job.status = "uncertain";
        job.error = error.message;
        await persist();
        return job;
      }
      job.status = "blocked";
      job.error = error.message;
      await persist();
      return job;
    }
    state.threadTurns[job.root] = (state.threadTurns[job.root] ?? 0) + 1;
    job.status = "delivered";
    job.postId = postId;
    await persist();
  }

  if (job.status === "delivered") {
    if (!String(job.event.id).startsWith("ready:")) await call("ack", { ids: [job.event.id] });
    job.status = "done";
    await persist();
  }
  return job;
}

/**
 * The listener's own process. It waits on the live inbox, advances jobs, and
 * keeps its durable state current so status, stop and retry all work against
 * facts rather than guesses.
 */
async function runListener({ identity, settings, deps }) {
  const path = statePath(identity.path);
  const previous = (await readJson(path)) ?? {};
  if (alive(previous.pid) && previous.pid !== process.pid)
    throw Error(`A listener for this identity is already running as process ${previous.pid}.`);

  const state = {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    phase: "starting",
    settings: { ...settings, instructionsText: undefined },
    cursor: previous.cursor ?? 0,
    turnStamps: previous.turnStamps ?? [],
    threadTurns: previous.threadTurns ?? {},
    jobs: previous.jobs ?? {},
  };
  // Work interrupted by a crash is never replayed on its own.
  for (const job of Object.values(state.jobs))
    if (job.status === "running") {
      job.status = "uncertain";
      job.error = "The listener stopped during this turn. Decide whether repeating it is safe, then listener-retry.";
    }

  const persist = () => writeJson(path, state);
  await persist();

  const budget = new TurnBudget(settings.maxTurns);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const setPhase = async (phase) => {
    state.phase = phase;
    state.pid = process.pid;
    await persist();
  };

  const drain = async () => {
    for (const job of Object.values(state.jobs)) {
      if (stopping) return;
      if (TERMINAL.has(job.status) || ["uncertain", "blocked"].includes(job.status)) continue;
      await setPhase("working");
      await advanceJob({ job, state, persist, call: identity.call, identity, settings, deps, budget });
    }
  };

  try {
    await drain();
    while (!stopping) {
      await setPhase("waiting");
      let page;
      try {
        page = await deps.waitForInbox({
          url: liveInboxUrl(identity.swarm.api),
          token: settings.token,
          timeoutMs: WAIT_SECONDS * 1000,
          readInbox: (signal) => identity.call(`inbox?after=${state.cursor}`, undefined, signal),
        });
      } catch (error) {
        if (stopping) break;
        state.lastError = error.message;
        await setPhase("reconnecting");
        if (error.rejectedIdentity) throw error;
        await new Promise((done) => setTimeout(done, 5000));
        continue;
      }
      delete state.lastError;
      const agents = (await identity.call("agents")).agents ?? [];
      await queueEvents({ events: page.events, state, agents, settings, agentId: identity.agentId });
      for (const event of page.events ?? [])
        await queueReadyTasks({ event, state, call: identity.call, settings, agentId: identity.agentId, agents });
      if (page.cursor !== undefined) state.cursor = page.cursor;
      await persist();
      await drain();
      if (settings.once) break;
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    state.pid = null;
    state.phase = "stopped";
    await persist().catch(() => {});
  }
  return listenerStatus(identity.path);
}

/**
 * The connector's command surface. `listen` starts the service; everything else
 * reads or adjusts its durable state without ever starting a model turn.
 */
export async function connector({ command, args = [], identity, token, cliPath, selector = [], deps = {} }) {
  const runtime = { runTurn: runRuntimeTurn, waitForInbox: liveWait, ...deps };
  switch (command) {
    case "listener-status":
      return listenerStatus(identity.path);
    case "listener-stop":
      return stopListener(identity.path);
    case "listener-retry": {
      const index = args.indexOf("--event");
      if (index < 0 || !args[index + 1]) throw Error("listener-retry needs --event EVENT_ID.");
      return retryJob(identity.path, args[index + 1]);
    }
    case "listen": {
      const settings = parseListenOptions(args);
      const probe = await probeRuntime(settings.runtime);
      if (!probe.available) throw Error(`${probe.label} is not usable here: ${probe.detail}`);
      if (settings.background)
        return startBackground({ configPath: identity.path, cliPath, settings, selector });
      return runListener({
        identity,
        settings: {
          ...settings,
          token,
          instructionsText: settings.instructions
            ? await readFile(settings.instructions, "utf8")
            : undefined,
        },
        deps: runtime,
      });
    }
    default:
      throw Error(`Unknown connector command ${command}.`);
  }
}

export { statePath, logPath, replyId, NO_REPLY };
