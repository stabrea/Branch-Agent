import type { Store } from "../store.js";
import { recordLockdownWith } from "../lockdown.js";
import { specFor } from "./catalogue.js";
import { currentValue, type Value } from "./changes.js";
import { recordSettingsChange, type ChangeEntry, type ChangeOrigin } from "./history.js";

/**
 * Q48 review: a setting's own card, the approval screen and the /preset command save around the
 * settings kit. Each of them runs its save through here, so what it changed in the catalogue is
 * written down as a change record just like a switch in Settings, and "why is this on?" names it.
 * Only the catalogue fields of the named settings are compared; nothing else is ever recorded.
 */
function snapshot(store: Store, owner: string, keys: readonly string[]): Map<string, Value> {
  const values = new Map<string, Value>();
  for (const key of keys) {
    const spec = specFor(key);
    for (const field of spec?.fields ?? []) values.set(`${key}.${field.field}`, currentValue(store, owner, spec!, field));
  }
  return values;
}

/**
 * Runs one save and records every catalogue field of `keys` it moved, as one transaction: a save
 * that throws, or a record that cannot be written, leaves the settings as they were. The save has
 * to finish at once; one still running when it returns is refused rather than recorded half done.
 */
export function recordedWrite<T>(store: Store, owner: string, origin: ChangeOrigin, keys: readonly string[], write: () => T): T {
  return recordWrite(store, owner, origin, keys, write).result;
}

/** The same, also saying which change record it wrote, or null when nothing in the catalogue moved. */
export function recordWrite<T>(store: Store, owner: string, origin: ChangeOrigin, keys: readonly string[], write: () => T): { result: T; record: string | null } {
  const unknown = keys.filter((key) => !specFor(key));
  // A name that is not a setting would record nothing without a word, so it is a mistake to say so.
  if (unknown.length) throw new Error(`Not a setting in the catalogue: ${unknown.join(", ")}`);
  return store.atomically(() => {
    const before = snapshot(store, owner, keys);
    const result = write();
    const after = snapshot(store, owner, keys);
    const changes: ChangeEntry[] = [];
    for (const [setting, was] of before) {
      const now = after.get(setting);
      if (now !== undefined && now !== was) changes.push({ setting, before: was, after: now });
    }
    return { result, record: changes.length ? recordSettingsChange(store, owner, origin, changes) : null };
  });
}

/** `[key]` when it is a setting in the catalogue, else nothing: for a family whose parts are not all settings here. */
export const inCatalogue = (key: string): string[] => (specFor(key) ? [key] : []);

/** A setting's own card in Settings, saving around the kit. */
export const byCard = (detail: string): ChangeOrigin => ({ writer: "owner-in-window", source: "card", detail });

/** Q48 review: what Lockdown changes among these settings, turning on or off, is recorded here too. */
recordLockdownWith((store, owner, origin, keys, write) =>
  recordWrite(store, owner, { ...origin, source: "lockdown" }, keys.flatMap(inCatalogue), write).record);
