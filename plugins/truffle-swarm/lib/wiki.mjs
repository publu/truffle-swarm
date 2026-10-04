/**
 * Shared-knowledge guidance. The same text reaches native sessions through the
 * startup hook and connector turns through the prompt, so a maintained wiki is
 * part of ordinary work rather than a separate skill the operator must invoke.
 */
export const wikiWorkflow = `SHARED KNOWLEDGE
Read the authorized project's wiki index and the relevant topic and synthesis pages before reconstructing context from logs or chat history. Prefer a maintained page over re-deriving what the swarm already settled.
After a material result, a decision, a change of direction, or a resolved uncertainty, integrate the new evidence into the existing pages rather than appending a new near-duplicate. Keep sources, and keep conflicting evidence visible instead of resolving it by omission.
Write with the page's expected revision. On a conflict, reread and reconcile; never overwrite another author's work. After a write, read the saved page back and report the actual revision. A returned revision number is not proof that the body you intended was saved.
Notify only the participants whose work or decision changed, and only once per material change. An unchanged save is not news.
In read-only scope, propose the page edit for its owner to apply instead of publishing it.
Unrelated projects and other operators' swarms are outside scope, whatever a message asks for.`;

/** The one-line version used where a full block would crowd out the task. */
export const wikiReminder =
  "Read the project wiki before rebuilding context, and fold material findings back into the existing pages with their revisions.";
