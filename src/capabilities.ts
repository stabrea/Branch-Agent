import { z } from "zod";
import type { Store } from "./store.js";
import { toolFeatures, type CapabilityGroup, type FeatureMode } from "./feature-switches.js";
import { lockdownActive, lockdownOverrides } from "./lockdown.js";
import { addOnParts, saveAddOnSettings, type AddOnPart } from "./add-ons/settings.js";
import { contextFileSettings, saveContextFileSettings, slots, switchFor, type SlotKey } from "./context-files.js";

/**
 * Owner item 17: the Capabilities page. Everything the assistant can switch on, each as one on/off
 * toggle, grouped, with the one Tool loading switch above them (src/feature-switches.ts).
 *
 * The stored three-way values are kept as they are: "on" is shown switched on (and marked as always
 * loaded, which it already was), "when needed" is shown switched on, "off" switched off. Switching one
 * on writes "when needed" (a record already "on" keeps it); switching it off writes "off". What the
 * switch then means for loading is the Tool loading switch's job, so nothing is migrated.
 */
export type CapabilityGroupName = CapabilityGroup | "files";
export interface CapabilityRow {
  key: string;
  label: string;
  group: CapabilityGroupName;
  on: boolean;
  /** Saved as "on" before this page: loaded from the first round whatever Tool loading says. */
  always: boolean;
  tools: number;
  /** Lockdown switches it off, and it cannot be switched on until Lockdown is. */
  locked: boolean;
}

const labelOf = (reason: string): string => {
  const words = reason.replace(/ (is|are) switched on$/, "");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const fileKey = (slot: SlotKey) => `context-files:${slot}`;
const rowKey = (key: string, field?: string) => (field && field !== "mode" ? `${key}#${field}` : key);

export function capabilityRows(store: Store, owner: string): CapabilityRow[] {
  const locked = lockdownActive(store, owner);
  const rows: CapabilityRow[] = toolFeatures.map((feature) => {
    const mode: FeatureMode = feature.mode(store, owner);
    return {
      key: rowKey(feature.key, feature.field), label: labelOf(feature.reason), group: feature.group,
      on: mode !== "off", always: mode === "on", tools: feature.tools.length,
      locked: !feature.key.startsWith("add-ons:") && lockdownOverrides(store, owner, feature.key),
    };
  });
  const files = contextFileSettings(store, owner);
  for (const slot of slots) {
    const mode = switchFor(files, slot.key);
    rows.push({ key: fileKey(slot.key), label: `${slot.names[0]}: ${slot.about}`, group: "files", on: mode !== "off", always: mode === "on", tools: 0, locked: false });
  }
  return locked ? rows : rows.map((row) => ({ ...row, locked: false }));
}

const SetSchema = z.object({ key: z.string().min(1).max(80), on: z.boolean() }).strict();
const next = (current: unknown, on: boolean): FeatureMode => (!on ? "off" : current === "on" ? "on" : "when-needed");

/** Switches one capability on or off, keeping a record's other fields and a legacy "on". */
export function setCapability(store: Store, owner: string, input: unknown): CapabilityRow {
  const { key, on } = SetSchema.parse(input);
  const row = capabilityRows(store, owner).find((entry) => entry.key === key);
  if (!row) throw new Error("There is no capability with that name.");
  if (on && row.locked) throw new Error("Lockdown is on, so this stays off until Lockdown is switched off.");
  if (key.startsWith("context-files:")) {
    const slot = key.slice("context-files:".length) as SlotKey;
    saveContextFileSettings(store, owner, { files: { [slot]: next(switchFor(contextFileSettings(store, owner), slot), on) } });
  } else if (key.startsWith("add-ons:")) {
    const part = key.slice("add-ons:".length) as AddOnPart;
    if (!addOnParts.includes(part)) throw new Error("There is no capability with that name.");
    saveAddOnSettings(store, owner, { modes: { [part]: next(row.always ? "on" : "off", on) } });
  } else {
    const [record, field = "mode"] = key.split("#") as [string, string?];
    const data = (store.get("settings", owner, record)?.data ?? {}) as Record<string, unknown>;
    // A record that keeps an older yes/no beside its switch has it kept in step.
    const kept = "enabled" in data ? { enabled: on } : {};
    store.save("settings", owner, record, { ...data, ...kept, [field]: next(data[field] ?? (row.always ? "on" : undefined), on) });
  }
  return capabilityRows(store, owner).find((entry) => entry.key === key)!;
}
