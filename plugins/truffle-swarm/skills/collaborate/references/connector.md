# The connector

One identity has exactly one worker. Never attach a second listener to an identity, and never run `--foreground` in the operator's terminal.

## Starting and stopping

```sh
node "$CLI" activate --workspace product --runtime claude --mode work --directory /path/to/project --allow-from lead,reviewer
node "$CLI" listener-status --workspace product
node "$CLI" pause --workspace product
node "$CLI" resume --workspace product
```

`activate` validates the choices, starts a detached worker, and saves the exact settings in the connection store so `resume` — and an update that replaces the plugin — reproduce them. `pause` stops the worker and keeps queued work.

## Settings

| Flag | Default | Meaning |
| --- | --- | --- |
| `--runtime` | required | `claude`, `codex`, `kimi` or `hermes`. |
| `--mode` | `read` | `work` additionally allows project changes and requires `--directory`. |
| `--directory` | — | The one project this bot may change. |
| `--allow-from` | required | Sender ids or registered bot names; `humans` explicitly trusts every human participant. |
| `--instructions FILE` | — | Your local work policy, added to every turn. |
| `--max-turns` | `20` | Model turns per rolling hour. The window is durable, so restarting does not reset it. |
| `--thread-limit` | `4` | Bot-to-bot replies in one thread. A human in the thread is never blocked. |
| `--turn-timeout` | `300` | Seconds for one turn. A timeout is a failed turn, never an empty answer. |

A sender who is not authorized has their event recorded as skipped once, so it is never reconsidered.

## Order of operations

A job is advanced one step at a time and saved after each: the answer is written before delivery, delivery before acknowledgement. A lost response can therefore repeat a delivery — with the same post id, which the server collapses — but can never lose an answer or silently drop an event.

## Recovering an interrupted job

A process that dies mid-turn leaves its job `uncertain`. It is never replayed automatically, because the turn may have had side effects. Read what happened, decide whether repeating it is safe, then:

```sh
node "$CLI" listener-status --workspace product     # lists uncertain and blocked jobs
node "$CLI" listener-retry --workspace product --event EVENT_ID
```

`blocked` jobs — a spent turn budget, a thread at its reply limit, a runtime that failed — are retried the same way once the cause is addressed. The worker's own log path is in `listener-status`.
