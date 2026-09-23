/**
 * Q45: the window's own choices, kept by the engine in the data folder instead of the page's browser
 * storage. Browser storage belongs to the page's address, and the desktop app picks a new port each
 * time it starts, so a choice kept only there was forgotten after an update. Here it is saved with
 * the workspace, under whoever the window is for (`profiles.scope()`: the owner's name, or a household
 * person's own), so switching person never shows or changes somebody else's choices.
 *
 * Only the fields named below are kept, each checked; nothing else from the page is ever stored.
 * A change names only the fields it changes, so a window that has been open a while never puts back
 * an old value of a field it did not touch. The two lists (tips already shown, questions already
 * asked) only ever grow by the entries a change adds, capped, so two windows adding at once both
 * count. The one-time import of what an older version left in browser storage only fills fields
 * that are still empty, and adds its older entries to the two lists: what the engine already holds
 * always wins, and a choice made here before the import never makes an older one get lost.
 */
import { z } from "zod";
import type { Store } from "./store.js";
import { importConversationMarks, markConversation, readConversationMarks, MARK_CAPS, MARK_ID_MAX, MARK_NAME_MAX, type ConversationMarks } from "./conversation-marks.js";
import { HttpError } from "./server-http.js";

const RECORD_ID = "ui-preferences";
/** The import from browser storage this version understands; a later one gets its own name. */
export const LEGACY_IMPORT = "legacy-local-v1";
/** The most entries a list keeps; the oldest go first. */
export const LIST_CAP = 50;

/** When something was last seen, in milliseconds since 1970: never before then, never absurdly late. */
const Stamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
/** The longest entry of each list, in UTF-16 units. */
const TIP_MAX = 80;
const ASKED_MAX = 200;
/** A tip's name, as the page's words name it (delight.tip.palette). */
const TipId = z.string().regex(new RegExp(`^[A-Za-z0-9._-]{1,${TIP_MAX}}$`));
/** A usage window's name (connection|account|window|refill): bounded, and no control characters. */
const AskedKey = z.string().min(1).max(ASKED_MAX).regex(/^[^\u0000-\u001f\u007f]+$/);
const LIST_ITEMS = { petTipsSeen: TipId, saveProgressAsked: AskedKey } as const;
type ListName = keyof typeof LIST_ITEMS;
const LISTS = Object.keys(LIST_ITEMS) as ListName[];

export const UiPreferenceFieldsSchema = z.object({
  /** The side list shows conversations or Trunks. */
  railView: z.enum(["conversations", "trunks"]),
  /** The side list and the side pane are open or folded away. */
  railOpen: z.boolean(),
  asideOpen: z.boolean(),
  /** Which tab of the side pane was last open. */
  paneTab: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** Settings › Appearance › Focus view. */
  focusView: z.boolean(),
  /** The side list's three groups, open or folded. */
  sectionsOpen: z.boolean(),
  projectsOpen: z.boolean(),
  recentsOpen: z.boolean(),
  /** Acknowledgements: when the Inbox was last looked at, and the one-time lines already shown. */
  inboxSeenAt: Stamp,
  calmTipSeen: z.boolean(),
  firstRunNextSeen: z.boolean(),
  petHintAt: Stamp,
  petTipsSeen: z.array(TipId).max(LIST_CAP),
  saveProgressAsked: z.array(AskedKey).max(LIST_CAP),
  /**
   * How wide the side list and the side panel were dragged, in CSS pixels (public/panels.js), within the
   * ranges the window allows. Kept per person like every other choice here, not per device yet: the
   * design asks geometry to be per device too, and Branch has no name for a computer's window to key it by.
   */
  paneWidths: z.object({
    rail: z.number().int().min(200).max(440).optional(),
    aside: z.number().int().min(260).max(640).optional(),
  }).strict(),
});
export type UiPreferenceFields = z.infer<typeof UiPreferenceFieldsSchema>;
export type UiPreferenceName = keyof UiPreferenceFields;
const NAMES = Object.keys(UiPreferenceFieldsSchema.shape) as UiPreferenceName[];
const SCALARS = NAMES.filter((name) => !(LISTS as string[]).includes(name));

const SavedSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  values: z.record(z.string(), z.unknown()).default({}),
  imports: z.record(z.string(), z.string()).default({}),
});

export interface UiPreferences {
  revision: number;
  values: Partial<UiPreferenceFields>;
  /** The imports from browser storage already done, by name, with when. */
  imports: Record<string, string>;
}

/** A list with only its entries that pass their check, each once, the newest `LIST_CAP` kept. */
function checkedList(name: ListName, input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const kept: string[] = [];
  for (const item of input) {
    if (!LIST_ITEMS[name].safeParse(item).success) continue;
    const at = kept.indexOf(item as string);
    if (at >= 0) kept.splice(at, 1);
    kept.push(item as string);
  }
  return kept.slice(-LIST_CAP);
}

/** Keeps only the named fields that pass their check; anything else is dropped, never stored. */
function checked(input: unknown): Partial<UiPreferenceFields> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  const offered = input as Record<string, unknown>;
  for (const name of SCALARS) {
    const parsed = UiPreferenceFieldsSchema.shape[name].safeParse(offered[name]);
    if (parsed.success) out[name] = parsed.data;
  }
  for (const name of LISTS) {
    const list = checkedList(name, offered[name]);
    if (list) out[name] = list;
  }
  return out as Partial<UiPreferenceFields>;
}

export function readUiPreferences(store: Store, owner: string): UiPreferences {
  const saved = SavedSchema.safeParse(store.get("settings", owner, RECORD_ID)?.data ?? {});
  const data = saved.success ? saved.data : SavedSchema.parse({});
  return { revision: data.revision, values: checked(data.values), imports: data.imports };
}

function write(store: Store, owner: string, next: UiPreferences): UiPreferences {
  store.save("settings", owner, RECORD_ID, { revision: next.revision, values: next.values, imports: next.imports });
  return next;
}

const PatchSchema = z.object({
  /** Each field to change; null takes a field back to its default. Unknown fields are refused. */
  set: z.object(Object.fromEntries(SCALARS.map((name) => [name, UiPreferenceFieldsSchema.shape[name].nullable().optional()])))
    .strict().default({}),
  /** Entries to add to a list; what is there already stays. */
  add: z.object(Object.fromEntries(LISTS.map((name) => [name, z.array(LIST_ITEMS[name]).max(LIST_CAP).optional()])))
    .strict().default({}),
}).strict();

/** Changes only the fields the change names, all together, and counts one revision. */
export function patchUiPreferences(store: Store, owner: string, input: unknown): UiPreferences {
  const { set, add } = PatchSchema.parse(input);
  const current = readUiPreferences(store, owner);
  const values: Record<string, unknown> = { ...current.values };
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) continue;
    if (value === null) delete values[name];
    else values[name] = value;
  }
  for (const [name, entries] of Object.entries(add) as [ListName, string[] | undefined][])
    if (entries?.length) values[name] = checkedList(name, [...(current.values[name] ?? []), ...entries]);
  return write(store, owner, { ...current, revision: current.revision + 1, values: values as Partial<UiPreferenceFields> });
}

const ImportSchema = z.object({ name: z.literal(LEGACY_IMPORT), values: z.unknown() }).strict();

/**
 * Brings in what an older version kept in this page's browser storage. Only fields the engine does
 * not hold yet are filled, and a value that fails its check is left out; doing it twice changes
 * nothing the first time did not. Only the owner's window imports: browser storage was shared by
 * everybody at this computer, so it cannot be told which household person a value belonged to.
 */
export function importUiPreferences(store: Store, owner: string, isOwner: boolean, input: unknown, now = new Date()): UiPreferences & { filled: UiPreferenceName[] } {
  const { name, values: offered } = ImportSchema.parse(input);
  const current = readUiPreferences(store, owner);
  if (!isOwner) return { ...current, filled: [] };
  const incoming = checked(offered);
  /* A list is merged, never dropped because an entry was added here first: the older entries go first. */
  const merged = (field: ListName): string[] => {
    const now = current.values[field] ?? [];
    return checkedList(field, [...(incoming[field] ?? []).filter((entry) => !now.includes(entry)), ...now]) ?? [];
  };
  const isList = (field: UiPreferenceName): field is ListName => (LISTS as string[]).includes(field);
  const filled = NAMES.filter((field) => incoming[field] !== undefined && (current.values[field] === undefined
    || (isList(field) && JSON.stringify(merged(field)) !== JSON.stringify(current.values[field]))));
  if (!filled.length && current.imports[name]) return { ...current, filled };
  const values: Record<string, unknown> = { ...current.values };
  for (const field of filled) values[field] = isList(field) ? merged(field) : incoming[field];
  const imports = current.imports[name] ? current.imports : { ...current.imports, [name]: now.toISOString() };
  const next = write(store, owner, {
    revision: current.revision + (filled.length ? 1 : 0), values: values as Partial<UiPreferenceFields>, imports,
  });
  return { ...next, filled };
}

/** The most bytes one string of up to `units` UTF-16 units takes as JSON, with its quotes: a lone surrogate is written \udXXX. */
const jsonBytes = (units: number) => 2 + 6 * units;
/** The same for a string of plain letters and digits. */
const plainBytes = (units: number) => 2 + units;
const LIST_BYTES = 64 + LIST_CAP * (plainBytes(TIP_MAX) + 1) + 64 + LIST_CAP * (jsonBytes(ASKED_MAX) + 1);
const SCALAR_BYTES = 128 * SCALARS.length;
const NAME_BYTES = plainBytes(MARK_ID_MAX) + 1 + jsonBytes(MARK_NAME_MAX) + 1;
const MARK_BYTES = 64 + MARK_CAPS.names * NAME_BYTES + (MARK_CAPS.pinned + MARK_CAPS.buried) * (plainBytes(MARK_ID_MAX) + 1);
const withMargin = (bytes: number) => Math.ceil((bytes + 256) * 1.1 / 1024) * 1024;
/** The largest body a change can need: every field, the most entries a list takes at once, and one label. */
export const CHANGE_BODY_LIMIT = withMargin(SCALAR_BYTES + LIST_BYTES + NAME_BYTES);
/** The largest body the one-time import can need: every field, full lists, and every label at its cap. */
export const IMPORT_BODY_LIMIT = withMargin(SCALAR_BYTES + LIST_BYTES + MARK_BYTES);

/** A request body as named parts, so the conversation labels can be taken out of it; anything else is left for the schema to refuse. */
const parts = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : { value: input };

/**
 * `GET /api/ui-preferences`, `POST /api/ui-preferences` (a change, and/or `mark`: one conversation's
 * label) and `POST /api/ui-preferences/import` (with `conversations`: the side list's older labels).
 * Each answer carries the conversation labels too, and says whether the record is the owner's
 * (`forOwner`), so a household person's window never shows, or keeps a copy of, what the owner left
 * in this page's shared browser storage.
 */
export async function uiPreferencesApi(
  deps: { store: Store; owner: string; isOwner: boolean }, method: string, path: string, body: () => Promise<unknown>,
): Promise<UiPreferences & { conversations: ConversationMarks; forOwner: boolean }> {
  const { store, owner, isOwner } = deps;
  const answer = async (): Promise<UiPreferences> => {
    if (path === "/api/ui-preferences" && method === "GET") return readUiPreferences(store, owner);
    if (path === "/api/ui-preferences" && method === "POST") {
      const { mark, ...change } = parts(await body());
      if (mark !== undefined) markConversation(store, owner, mark);
      return mark === undefined || Object.keys(change).length ? patchUiPreferences(store, owner, change) : readUiPreferences(store, owner);
    }
    if (path === "/api/ui-preferences/import" && method === "POST") {
      const { conversations, ...offered } = parts(await body());
      const before = readUiPreferences(store, owner).imports[LEGACY_IMPORT];
      const imported = importUiPreferences(store, owner, isOwner, offered);
      /* Once, with the rest of the import, and only for the owner, as for every other choice. */
      if (isOwner && !before && conversations !== undefined) importConversationMarks(store, owner, conversations);
      return imported;
    }
    throw new HttpError(405, "Use GET or POST");
  };
  const result = await answer();
  return { ...result, conversations: readConversationMarks(store, owner), forOwner: isOwner };
}
