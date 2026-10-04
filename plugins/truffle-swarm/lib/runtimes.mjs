import { spawn } from "node:child_process";

/**
 * Each supported runtime answers two questions: how to run one headless turn,
 * and how to read the answer back out. Nothing here knows about swarms, so a
 * new runtime is a table entry rather than a change to the connector.
 */
export const runtimes = {
  claude: {
    label: "Claude Code",
    command: "claude",
    probe: ["--version"],
    turn: ({ prompt, mode }) => [
      "--print",
      "--output-format",
      "json",
      ...(mode === "work" ? [] : ["--permission-mode", "plan"]),
      prompt,
    ],
    answer: (stdout) => {
      const parsed = JSON.parse(stdout);
      if (parsed.is_error) throw Error(parsed.result || "The runtime reported an error.");
      return String(parsed.result ?? "").trim();
    },
  },
  codex: {
    label: "Codex",
    command: "codex",
    probe: ["--version"],
    turn: ({ prompt, mode }) => [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      mode === "work" ? "workspace-write" : "read-only",
      prompt,
    ],
    // Codex streams JSON lines; the last agent message is the answer.
    answer: (stdout) => {
      let answer = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const message = event.msg ?? event;
        if (message.type === "agent_message" && message.message) answer = message.message;
        if (message.type === "error" && message.message) throw Error(message.message);
      }
      return answer.trim();
    },
  },
  kimi: {
    label: "Kimi CLI",
    command: "kimi",
    probe: ["--version"],
    turn: ({ prompt }) => ["--print", prompt],
    answer: (stdout) => stdout.trim(),
  },
  hermes: {
    label: "Hermes",
    command: "hermes",
    probe: ["--version"],
    turn: ({ prompt }) => ["run", "--quiet", prompt],
    answer: (stdout) => stdout.trim(),
  },
};

export const runtimeNames = Object.keys(runtimes);

export function runtimeFor(name) {
  const runtime = runtimes[name];
  if (!runtime)
    throw Error(`Unknown runtime ${name}. Choose one of ${runtimeNames.join(", ")}.`);
  return runtime;
}

/** Spawn a command, capture its output, and kill it at the timeout. */
export function runCommand(command, args, { cwd, env, timeoutMs, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // A runtime that ignores SIGTERM still has to stop.
          setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message, failed: true, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, failed: code !== 0, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Check a runtime is installed before a listener promises to answer with it. */
export async function probeRuntime(name) {
  const runtime = runtimeFor(name);
  const result = await runCommand(runtime.command, runtime.probe, { timeoutMs: 20000 });
  return {
    runtime: name,
    label: runtime.label,
    available: !result.failed,
    version: result.failed ? undefined : result.stdout.trim().split("\n")[0],
    ...(result.failed
      ? { detail: `${runtime.command} is not installed, not signed in, or not on PATH.` }
      : {}),
  };
}

/**
 * Run one headless turn. A timeout or a crash is reported as a failed turn, not
 * as an empty answer: an empty answer would be delivered as a reply.
 */
export async function runTurn(name, { prompt, mode, cwd, timeoutMs }) {
  const runtime = runtimeFor(name);
  const result = await runCommand(runtime.command, runtime.turn({ prompt, mode }), {
    cwd,
    timeoutMs,
    env: { TRUFFLE_CONNECTOR: "1" },
  });
  if (result.timedOut) throw Error(`${runtime.label} exceeded its turn timeout.`);
  if (result.failed)
    throw Error(
      `${runtime.label} stopped before answering: ${(result.stderr || result.stdout).trim().slice(0, 500) || "no output"}`,
    );
  return runtime.answer(result.stdout);
}
