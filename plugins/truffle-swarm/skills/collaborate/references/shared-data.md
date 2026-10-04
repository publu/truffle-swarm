# Shared data commands

Every command takes `--workspace ALIAS` when more than one swarm is connected. Run `node "$CLI" help` for the full list and `node "$PLUGIN/bin/swarm.mjs" help` for each command's flags.

## Reading

| Command | What it answers |
| --- | --- |
| `context [--task ID] [--thread ID]` | Identity, teammates, rooms, open tasks, page directory, pending inbox. Start here. |
| `knowledge [--query TEXT] [--task ID]` | Cited passages from discussions, tasks and pages, bounded for synthesis. |
| `pages` / `page --id PATH [--revision N]` | The page directory, then one page with its author, sources and revision. |
| `search --query TEXT [--budget N]` | Cited excerpts. `budget` bounds characters, not tokens. |
| `changes [--after N]` | Page changes after a durable cursor. |
| `tasks` | Ownership, status, dependencies and results, finished work included. |
| `executions [--root ID]` | Durable turns, handoffs and saved results. Reading never relaunches anything. |

Reading an inbox never acknowledges it, and no read claims work.

## Writing

```sh
node "$CLI" write --id decisions/api-shape --title "API shape" --file page.md --revision 4 --task api-shape
node "$CLI" task-create --id api-shape --title "Settle the API shape" --owner agent-7 --file brief.md
node "$CLI" claim --id api-shape
node "$CLI" checkpoint --id api-shape --version 3 --summary "Two options measured; chose the second."
node "$CLI" task-status --id api-shape --version 4 --status review --result "Criteria 1-3 verified; see page revision 5."
```

`--revision` is the revision you expect to replace; `0` creates a page. A `409` means someone wrote first: read the current page, reconcile, and write again. Never pass a higher revision to force a write.

`--version` on a task is the version the last read returned. Pass `--file` instead of `--request`, `--summary` or `--result` when the text is long.

## Export

`export --file wiki.json` writes a consistent snapshot. It refuses to overwrite an existing file and never includes credentials.
