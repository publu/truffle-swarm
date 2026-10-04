// A connector turn gets shared context as JSON. Budgeting by characters alone
// would cut a record in half, so whole records are kept or dropped and every
// drop is reported: a turn must never guess at content it was not shown.

const SCALARS = ["protocolVersion", "swarm", "actor", "task", "counts", "truncated", "releases"];
const COLLECTIONS = { sources: 10, tasks: 10, agents: 20, rooms: 10, inbox: 10 };
const RESERVE = 1200;

/** Shrink shared context to `max` characters of JSON without producing a lie. */
export function boundedContext(context = {}, max = 12000) {
  const selected = {};
  const omitted = [];
  const size = (candidate) => JSON.stringify({ ...selected, ...candidate, omitted }).length;

  const add = (key, value) => {
    if (value === undefined) return false;
    if (size({ [key]: value }) > max - RESERVE) {
      omitted.push({ section: key, reason: "Read the source before relying on it." });
      return false;
    }
    selected[key] = value;
    return true;
  };

  // Guidance is only meaningful for the identity it was issued to.
  if (context.guidance?.version === 1 && context.guidance.actor === context.actor)
    add("guidance", context.guidance);
  for (const key of SCALARS) add(key, context[key]);
  add("wikiEntry", context.wikiEntry);

  for (const [key, cap] of Object.entries(COLLECTIONS)) {
    const records = context[key];
    if (!Array.isArray(records)) continue;
    const kept = [];
    for (const record of records) {
      if (kept.length >= cap) break;
      if (size({ [key]: [...kept, record] }) > max - RESERVE) break;
      kept.push(record);
    }
    selected[key] = kept;
    if (kept.length < records.length)
      omitted.push({ section: key, count: records.length - kept.length });
  }

  if (context.wiki) {
    const pages = (context.wiki.pages ?? [])
      .slice(0, 12)
      .map(({ id, title, revision }) => ({ id, title, revision }));
    if (add("wiki", { pages, cursor: context.wiki.cursor }) && pages.length < (context.wiki.pages ?? []).length)
      omitted.push({ section: "wiki", count: context.wiki.pages.length - pages.length });
  }

  selected.omitted = omitted;
  return selected;
}

/** Thread messages for a turn: the root, the trigger in full, recent context trimmed. */
export function boundedThread(thread, triggerId, { triggerMax = 8000, contextMax = 2000 } = {}) {
  const posts = [thread.root, ...(thread.replies ?? [])];
  const recent = [thread.root, ...(thread.replies ?? []).slice(-10)];
  const trigger = posts.find((post) => post.id === triggerId);
  const unique = [...new Map([...recent, ...(trigger ? [trigger] : [])].map((post) => [post.id, post])).values()];
  return unique.map((post) => {
    const limit = post.id === triggerId ? triggerMax : contextMax;
    return {
      id: post.id,
      author: post.author,
      text: post.body.slice(0, limit),
      ...(post.body.length > limit ? { truncated: true } : {}),
    };
  });
}
