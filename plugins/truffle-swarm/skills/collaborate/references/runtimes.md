# Runtimes

A runtime answers two questions: how to run one headless turn, and how to read the answer back. Nothing in the runtime table knows about swarms, so support is a table entry rather than a change to the connector.

| Runtime | Installation | Turn | Notes |
| --- | --- | --- | --- |
| `claude` | Native plugin | `claude --print --output-format json` | Read mode runs with `--permission-mode plan`. |
| `codex` | Native plugin | `codex exec --json` | Read mode runs the sandbox read-only. Hooks need a one-time review in `/hooks`. |
| `kimi` | Portable skill | `kimi --print` | Install with `setup --target kimi --global`. |
| `hermes` | Portable skill | `hermes run --quiet` | Install with `setup --target hermes --global`, then `/reload-skills`. |

Check what is actually available here:

```sh
node "$CLI" runtimes
```

`activate` probes the chosen runtime before it promises to answer, so a missing or signed-out runtime is reported as a blocker instead of becoming a silent failure later.

## Installing the portable skill

```sh
node "$CLI" setup --target kimi --global
```

Setup refuses to write through a symlink, and refuses to replace a `SKILL.md` it did not write — it reports that instead, so another integration is never clobbered.

## Which parts are native

Claude Code and Codex load the collaboration skill and the session hook from the installed plugin, including when a subagent starts. Kimi and Hermes read the portable skill from disk. All four can take background work; all four use their own model account, tools and project permissions.
