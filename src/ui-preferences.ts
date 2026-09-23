/**
 * Q45: the window's own choices, kept by the engine in the data folder instead of the page's browser
 * storage. Browser storage belongs to the page's address, and the desktop app picks a new port each
 * time it starts, so a choice kept only there was forgotten after an update. Here it is saved with
 * the workspace, under whoever the window is for (`runtime.owner`, the same scope `/api/look` uses).
 *
 * Only the fields named below are kept, each checked; nothing else from the page is ever stored.
 * A change names only the fields it changes, so a window that has been open a while never puts back
 * an old value of a field it did not touch. The one-time import of what an older version left in
 * browser storage only fills fields that are still empty: what the engine already holds always wins.
 */
import { z } from "zod";
import type { Store } from "./store.js";

const RECORD_ID = "ui-preferences";
/** The import from browser storage this version understands; a later one gets its own name. */
export const LEGACY_IMPORT = "legacy-local-v1";

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
});
export type UiPreferenceFields = z.infer<typeof UiPreferenceFieldsSchema>;
export type UiPreferenceName = keyof UiPreferenceFields;
const NAMES = Object.keys(UiPreferenceFieldsSchema.shape) as UiPreferenceName[];

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

/** Keeps only the named fields that pass their check; anything else is dropped, never stored. */
function checked(input: unknown): Partial<UiPreferenceFields> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const name of NAMES) {
    const parsed = UiPreferenceFieldsSchema.shape[name].safeParse((input as Record<string, unknown>)[name]);
    if (parsed.success) out[name] = parsed.data;
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
  set: z.object(Object.fromEntries(NAMES.map((name) => [name, UiPreferenceFieldsSchema.shape[name].nullable().optional()])))
    .strict(),
}).strict();

/** Changes only the fields the change names, all together, and counts one revision. */
export function patchUiPreferences(store: Store, owner: string, input: unknown): UiPreferences {
  const { set } = PatchSchema.parse(input);
  const current = readUiPreferences(store, owner);
  const values: Record<string, unknown> = { ...current.values };
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) continue;
    if (value === null) delete values[name];
    else values[name] = value;
  }
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
  const filled = NAMES.filter((field) => incoming[field] !== undefined && current.values[field] === undefined);
  if (!filled.length && current.imports[name]) return { ...current, filled };
  const values: Record<string, unknown> = { ...current.values };
  for (const field of filled) values[field] = incoming[field];
  const imports = current.imports[name] ? current.imports : { ...current.imports, [name]: now.toISOString() };
  const next = write(store, owner, {
    revision: current.revision + (filled.length ? 1 : 0), values: values as Partial<UiPreferenceFields>, imports,
  });
  return { ...next, filled };
}

/** `GET /api/ui-preferences`, `POST /api/ui-preferences` (a change) and `POST /api/ui-preferences/import`. */
export async function uiPreferencesApi(
  deps: { store: Store; owner: string; isOwner: boolean }, method: string, path: string, body: () => Promise<unknown>,
): Promise<UiPreferences> {
  if (path === "/api/ui-preferences" && method === "GET") return readUiPreferences(deps.store, deps.owner);
  if (path === "/api/ui-preferences" && method === "POST") return patchUiPreferences(deps.store, deps.owner, await body());
  if (path === "/api/ui-preferences/import" && method === "POST")
    return importUiPreferences(deps.store, deps.owner, deps.isOwner, await body());
  throw Object.assign(new Error("Use GET or POST"), { status: 405 });
}
