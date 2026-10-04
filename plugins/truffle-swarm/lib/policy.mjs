import { createHash } from "node:crypto";

const HUMAN = /^(human-|account:)/;

/**
 * A post id derived from the swarm, this identity and the event it answers.
 * Re-delivering after an uncertain network failure reuses the same id, so the
 * server can collapse the repeat instead of double-posting an answer.
 */
export function replyId(api, actor, eventId) {
  const hex = createHash("sha256").update(`${api}\n${actor}\n${eventId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Turn an operator's answer to "who may give this bot work?" into a stored
 * allow list. "humans" is an explicit choice to trust every human participant;
 * it is never inferred from a swarm being public.
 */
export function parseAllowList(values) {
  const entries = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!entries.length)
    throw Error("Name who may send this bot work: sender ids, registered bot names, or humans.");
  return [...new Set(entries)];
}

/**
 * Decide whether an event's sender is authorized. A name only counts when it
 * belongs to a real registered agent, so a demo entry cannot borrow a trusted name.
 */
export function allowedSender(event, agents, allow) {
  if (!allow?.length) return false;
  if (allow.includes(event.actor)) return true;
  if (allow.includes("humans") && HUMAN.test(event.actor)) return true;
  const sender = (agents ?? []).find((agent) => agent.id === event.actor);
  return Boolean(sender && !sender.demo && allow.includes(sender.name));
}

export function isHuman(actor) {
  return HUMAN.test(String(actor ?? ""));
}

/**
 * Turns per rolling hour. The window lives in the listener's durable state, so
 * a restart cannot be used to reset the budget.
 */
export class TurnBudget {
  constructor(maxPerHour, windowMs = 3600000) {
    this.max = maxPerHour;
    this.windowMs = windowMs;
  }
  /** Drop expired stamps and report whether one more turn fits. */
  check(stamps, now = Date.now()) {
    const recent = (stamps ?? []).filter((at) => now - at < this.windowMs);
    return {
      stamps: recent,
      allowed: recent.length < this.max,
      retryAfterMs: recent.length < this.max ? 0 : this.windowMs - (now - recent[0]),
    };
  }
  record(stamps, now = Date.now()) {
    return [...this.check(stamps, now).stamps, now];
  }
}

/**
 * Bot-to-bot replies in one thread are capped so two connectors cannot talk to
 * each other forever. A human in the thread is always allowed through.
 */
export function withinThreadBudget({ actor, turns, limit }) {
  return isHuman(actor) || (turns ?? 0) < limit;
}

/**
 * A task becomes workable when this identity owns it, it is still queued, its
 * creator is authorized, and every prerequisite is actually done. Each clause
 * is a separate fact; none of them implies another.
 */
export function readyTask({ task, tasks, agentId, agents, allow }) {
  return Boolean(
    task &&
      task.owner === agentId &&
      task.status === "todo" &&
      allowedSender({ actor: task.creator }, agents, allow) &&
      (task.dependencies ?? []).every((id) => tasks.some((other) => other.id === id && other.status === "done")),
  );
}
