import { z } from "zod";
import type { Store } from "./store.js";
import type { FeatureMode } from "./feature-switches.js";
import { lockdownActive, lockdownOverrides } from "./lockdown.js";
import { addOnMode, addOnParts, saveAddOnSettings, type AddOnPart } from "./add-ons/settings.js";
import { contextFileSettings, saveContextFileSettings, switchFor, type SlotKey } from "./context-files.js";
import { capabilities, labelKeyOf, type Capability, type CapabilityGroupName, type LiveModules } from "./capabilities-table.js";

/**
 * Owner item 17: the Capabilities page. Everything the assistant can do (src/capabilities-table.ts),
 * each as one on/off toggle, grouped, with the one Tool loading switch above them.
 *
 * The stored three-way values are kept as they are: "on" is shown switched on (and marked as always
 * loaded, which it already was), "when needed" is shown switched on, "off" switched off. Switching one
 * on writes "when needed" (a record already "on" keeps it); switching it off writes "off". What the
 * switch then means for loading is the Tool loading switch's job, so nothing is migrated.
 */
export type { CapabilityGroupName };
export interface CapabilityRow {
  key: string;
  label: string;
  /** Its name in the language files (every capability has one, in every shipped language). */
  labelKey: string;
  group: CapabilityGroupName;
  /** In use now: a part whose root is off reads off, whatever it was saved as. */
  on: boolean;
  /** Saved as "on" before this page: loaded from the first round whatever Tool loading says. */
  always: boolean;
  tools: number;
  /** Lockdown switches it off, and it cannot be switched on until Lockdown is. */
  locked: boolean;
  /** The capability this one only works with, when that one is off (switching this on switches both). */
  needs?: { key: string; labelKey: string };
}

const byId = new Map(capabilities.map((entry) => [entry.id, entry]));
const recordOf = (id: string): string => id.split("#")[0]!;
const lockable = (id: string): boolean => !id.startsWith("add-ons:") && !id.startsWith("context-files:");

function rowFor(store: Store, owner: string, entry: Capability, locked: boolean): CapabilityRow {
  const mode = entry.effective(store, owner);
  const root = entry.needs ? byId.get(entry.needs) : undefined;
  return {
    key: entry.id, label: entry.label, labelKey: labelKeyOf(entry.id), group: entry.group,
    on: mode !== "off", always: mode === "on", tools: entry.tools.length,
    locked: locked && lockable(entry.id) && lockdownOverrides(store, owner, recordOf(entry.id)),
    ...(root && root.effective(store, owner) === "off" ? { needs: { key: root.id, labelKey: labelKeyOf(root.id) } } : {}),
  };
}

export function capabilityRows(store: Store, owner: string): CapabilityRow[] {
  const locked = lockdownActive(store, owner);
  return capabilities.map((entry) => rowFor(store, owner, entry, locked));
}

const SetSchema = z.object({ key: z.string().min(1).max(80), on: z.boolean() }).strict();
const next = (current: unknown, on: boolean): FeatureMode => (!on ? "off" : current === "on" ? "on" : "when-needed");

/**
 * Writes one capability's switch. A switch with a running side goes through its live module, so the
 * change takes effect now (tools registered or removed, work cancelled, connections closed); the rest
 * are saved, keeping a record's other fields and a legacy "on".
 */
async function write(store: Store, owner: string, live: LiveModules, entry: Capability, on: boolean): Promise<void> {
  const id = entry.id;
  if (entry.live) { await entry.live(live, next(entry.effective(store, owner), on)); return; }
  if (id.startsWith("context-files:")) {
    const slot = id.slice("context-files:".length) as SlotKey;
    saveContextFileSettings(store, owner, { files: { [slot]: next(switchFor(contextFileSettings(store, owner), slot), on) } });
  } else if (id.startsWith("add-ons:")) {
    const part = id.slice("add-ons:".length) as AddOnPart;
    if (!addOnParts.includes(part)) throw new Error("There is no capability with that name.");
    saveAddOnSettings(store, owner, { modes: { [part]: next(addOnMode(store, owner, part), on) } });
  } else {
    const [record, field = "mode"] = id.split("#") as [string, string?];
    const data = (store.get("settings", owner, record)?.data ?? {}) as Record<string, unknown>;
    // A record that keeps an older yes/no beside its switch has it kept in step.
    const kept = "enabled" in data ? { enabled: on } : {};
    store.save("settings", owner, record, { ...data, ...kept, [field]: next(data[field] ?? (data.enabled === true ? "when-needed" : undefined), on) });
  }
}

/** `GET|POST /api/capabilities`: the owner's alone, checked here so the guard moves with the route. */
export async function capabilitiesRoute(store: Store, owner: string, live: LiveModules, method: string, body: () => Promise<unknown>, toolLoading: () => unknown): Promise<unknown> {
  store.profiles.requireOwner("What the assistant can do");
  if (method === "POST") return setCapability(store, owner, live, await body());
  if (method !== "GET") throw new Error("Use GET or POST");
  return { toolLoading: toolLoading(), rows: capabilityRows(store, owner) };
}

/** Switches one capability on or off. On also switches on what it needs, so it works at once. */
export async function setCapability(store: Store, owner: string, live: LiveModules, input: unknown): Promise<CapabilityRow> {
  const { key, on } = SetSchema.parse(input);
  const entry = byId.get(key);
  if (!entry) throw new Error("There is no capability with that name.");
  const row = rowFor(store, owner, entry, lockdownActive(store, owner));
  if (on && row.locked) throw new Error("Lockdown is on, so this stays off until Lockdown is switched off.");
  if (on && row.needs) {
    const rootEntry = byId.get(row.needs.key)!;
    const root = rowFor(store, owner, rootEntry, lockdownActive(store, owner));
    if (root.locked) throw new Error("Lockdown is on, so this stays off until Lockdown is switched off.");
    await write(store, owner, live, rootEntry, true); // through the root's own setter too
  }
  await write(store, owner, live, entry, on);
  return rowFor(store, owner, entry, lockdownActive(store, owner));
}
