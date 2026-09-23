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
/** The longest conversation id (letters, digits, - and _ only) and the longest chosen name, in UTF-16 units. */
export const MARK_ID_MAX = 100;
export const MARK_NAME_MAX = 120;
const SessionId = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${MARK_ID_MAX}}$`));
const Name = z.string().trim().min(1).max(MARK_NAME_MAX).regex(/^[^\u0000-\u001f\u007f]+$/);

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
 * The one-time import of what an older version kept in this page's storage, kept only for conversations
 * this person owns, whatever the page offered. It is merged into what the engine holds, never dropped
 * because a label was made here first: an older label is older than any made here, so it goes first
 * and a name chosen here wins over an older one for the same conversation. The caps then drop the oldest.
 */
export function importConversationMarks(store: Store, owner: string, offered: unknown): ConversationMarks {
  const current = readConversationMarks(store, owner);
  const incoming = checkedMarks(offered, (id) => store.ownsSession(owner, id));
  const older = (list: string[], now: string[]) => [...list.filter((id) => !now.includes(id)), ...now];
  const names = [...Object.entries(incoming.names).filter(([id]) => !(id in current.names)), ...Object.entries(current.names)];
  return save(store, owner, checkedMarks({
    names: Object.fromEntries(names),
    pinned: older(incoming.pinned, current.pinned),
    buried: older(incoming.buried, current.buried),
  }, () => true));
}
