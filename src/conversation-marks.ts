/**
 * Q45: the side list's own labels for conversations (a name, a pin, or taken off the list) kept by the
 * engine under whoever is using the window, instead of in the page's browser storage, which belongs to
 * the page's address and was forgotten after an update. The conversation itself is never changed.
 *
 * Only a conversation the person owns can be labelled, checked against the saved conversations each
 * time a label is added or imported, so a label never lands on, or reveals, somebody else's. Each list
 * is capped; the oldest entries go first.
 */
import { z } from "zod";
import type { Store } from "./store.js";

const RECORD_ID = "conversation-marks";
export const MARK_CAPS = { names: 500, pinned: 200, buried: 1000 } as const;
const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Name = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);

export interface ConversationMarks {
  /** A name chosen for a conversation, by its id. */
  names: Record<string, string>;
  /** Conversations pinned to the top of the side list, oldest first. */
  pinned: string[];
  /** Conversations taken off the side list; they are still under Saved conversations. */
  buried: string[];
}

function ids(list: unknown, cap: number, owns: (id: string) => boolean): string[] {
  const kept: string[] = [];
  if (Array.isArray(list))
    for (const id of list) if (SessionId.safeParse(id).success && !kept.includes(id) && owns(id)) kept.push(id);
  return kept.slice(-cap);
}

/** Only well-formed labels for conversations `owns` says are this person's, each once, capped. */
function checkedMarks(input: unknown, owns: (id: string) => boolean): ConversationMarks {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const offered = raw.names && typeof raw.names === "object" && !Array.isArray(raw.names) ? Object.entries(raw.names) : [];
  const names: [string, string][] = [];
  for (const [id, name] of offered) {
    const parsed = Name.safeParse(name);
    if (SessionId.safeParse(id).success && parsed.success && owns(id)) names.push([id, parsed.data]);
  }
  return {
    names: Object.fromEntries(names.slice(-MARK_CAPS.names)),
    pinned: ids(raw.pinned, MARK_CAPS.pinned, owns),
    buried: ids(raw.buried, MARK_CAPS.buried, owns),
  };
}

export function readConversationMarks(store: Store, owner: string): ConversationMarks {
  return checkedMarks(store.get("settings", owner, RECORD_ID)?.data, () => true);
}

function save(store: Store, owner: string, marks: ConversationMarks): ConversationMarks {
  store.save("settings", owner, RECORD_ID, { ...marks });
  return marks;
}

export const MarkSchema = z.object({
  id: SessionId,
  /** A new name; null takes the chosen name away. */
  name: Name.nullable().optional(),
  pinned: z.boolean().optional(),
  buried: z.boolean().optional(),
}).strict();

/** Labels one of the person's own conversations; any other conversation is refused as not found. */
export function markConversation(store: Store, owner: string, input: unknown): ConversationMarks {
  const mark = MarkSchema.parse(input);
  if (!store.ownsSession(owner, mark.id)) throw new Error("Conversation not found");
  const marks = readConversationMarks(store, owner);
  if (mark.name !== undefined) {
    delete marks.names[mark.id];
    if (mark.name !== null) marks.names[mark.id] = mark.name;
  }
  const put = (list: string[], on: boolean) => [...list.filter((id) => id !== mark.id), ...(on ? [mark.id] : [])];
  if (mark.pinned !== undefined) marks.pinned = put(marks.pinned, mark.pinned);
  if (mark.buried !== undefined) marks.buried = put(marks.buried, mark.buried);
  return save(store, owner, checkedMarks(marks, () => true));
}

/**
 * The one-time import of what an older version kept in this page's storage: it fills only a list the
 * engine does not hold yet, and keeps only conversations this person owns, whatever the page offered.
 */
export function importConversationMarks(store: Store, owner: string, offered: unknown): ConversationMarks {
  const current = readConversationMarks(store, owner);
  const incoming = checkedMarks(offered, (id) => store.ownsSession(owner, id));
  return save(store, owner, {
    names: Object.keys(current.names).length ? current.names : incoming.names,
    pinned: current.pinned.length ? current.pinned : incoming.pinned,
    buried: current.buried.length ? current.buried : incoming.buried,
  });
}
