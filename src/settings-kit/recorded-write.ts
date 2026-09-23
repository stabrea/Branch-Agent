import type { Store } from "../store.js";
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

/** Runs one save and records every catalogue field of `keys` it moved. A save that throws records nothing. */
export function recordedWrite<T>(store: Store, owner: string, origin: ChangeOrigin, keys: readonly string[], write: () => T): T {
  const before = snapshot(store, owner, keys);
  const result = write();
  const after = snapshot(store, owner, keys);
  const changes: ChangeEntry[] = [];
  for (const [setting, was] of before) {
    const now = after.get(setting);
    if (now !== undefined && now !== was) changes.push({ setting, before: was, after: now });
  }
  if (changes.length) recordSettingsChange(store, owner, origin, changes);
  return result;
}

