import { z } from "zod";
import type { Store } from "../store.js";

/**
 * mac7/wake-pins: settings the owner has pinned.
 *
 * A pinned setting is fixed. Somebody else who uses this computer sees it, sees that it is pinned,
 * and cannot change it: every way of writing a setting — the window, the API, the terminal, a
 * settings file, a whole-app preset, a tool the model calls — meets the same refusal in the same
 * plain words. Pinning and unpinning are the owner's alone.
 *
 * This file is deliberately small and imports nothing but zod and the type of the store, because
 * `Store.save` asks it about every settings write. Everything it needs to decide — the value that
 * was pinned, the value the field falls back to when a record does not carry it, and whether the
 * record keeps an older yes/no beside its switch — is written into the pin when it is made, by the
 * one caller that does hold the catalogue (src/settings-kit/api.ts).
 */
export const pinsKey = "settings-pins";

export const PinSchema = z.object({
  key: z.string().min(1).max(80),
  field: z.string().min(1).max(80),
  /** What the setting is fixed at. */
  value: z.union([z.string().max(60), z.number(), z.boolean()]),
  /** What the field means when a saved record does not carry it at all. */
  initial: z.union([z.string().max(60), z.number(), z.boolean()]),
  /** The record keeps an older yes/no beside its switch (src/feature-switches.ts, modeOf). */
  keepsEnabled: z.boolean().default(false),
  /** The setting's name and the field's label, so a refusal can say which setting in plain words. */
  name: z.string().max(120).default(""),
  label: z.string().max(120).default(""),
}).strict();
export type Pin = z.infer<typeof PinSchema>;

const PinsRecordSchema = z.object({ pins: z.array(PinSchema).max(200).default([]) }).strict();

export const pinId = (key: string, field: string): string => `${key}.${field}`;

/** Every pin the owner has made. A damaged record counts as no pins at all, never as a lock-out. */
export function pins(store: Pick<Store, "get">, owner: string): Pin[] {
  const saved = PinsRecordSchema.safeParse(store.get("settings", owner, pinsKey)?.data ?? {});
  return saved.success ? saved.data.pins : [];
}

/** The pin on one field, or undefined. */
export function pinFor(store: Pick<Store, "get">, owner: string, key: string, field: string): Pin | undefined {
  return pins(store, owner).find((pin) => pin.key === key && pin.field === field);
}

/** The ids of every pinned field, for a page or a preview that only has to mark them. */
export function pinnedIds(store: Pick<Store, "get">, owner: string): Set<string> {
  return new Set(pins(store, owner).map((pin) => pinId(pin.key, pin.field)));
}

/** The sentence every refusal says, whichever way in was tried. */
export function pinnedRefusal(pin: Pin): string {
  const what = pin.label && pin.name ? `${pin.name}: ${pin.label}` : pin.name || pinId(pin.key, pin.field);
  return `The owner pinned this setting (${what}), so it cannot be changed here. Only the owner can unpin it, in Settings.`;
}

/**
 * Puts a pin in or takes it out. The caller has already checked that this is the owner and that the
 * field is one the catalogue knows; nothing here can invent a pin on a setting that does not exist.
 */
export function savePins(store: Store, owner: string, next: readonly Pin[]): Pin[] {
  const list = PinsRecordSchema.parse({ pins: next.map((pin) => PinSchema.parse(pin)) }).pins;
  store.save("settings", owner, pinsKey, { pins: list });
  return list;
}

const readPath = (data: Record<string, unknown>, field: string): unknown =>
  field.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), data);

/**
 * What a record would mean for one pinned field. Written out here rather than borrowed from
 * src/settings-kit/changes.ts so that a record which leaves the field out, or carries only the
 * older yes/no beside the switch, is read the same way the feature itself reads it — otherwise a
 * write that dropped `mode` and flipped `enabled` would slip past a plain comparison.
 */
export function effectiveValue(pin: Pin, data: Record<string, unknown>): unknown {
  const saved = readPath(data, pin.field);
  if (saved !== undefined) return saved;
  if (pin.field === "mode" && pin.keepsEnabled && data.enabled === true) return "when-needed";
  return pin.initial;
}

/**
 * Why this settings write is refused, or null. Asked by `Store.save` about every settings record, so
 * a way in that nobody thought of meets the pin as well. The owner is never refused: a pin is the
 * owner's own mark, and they change a pinned setting by pinning it somewhere else or unpinning it.
 */
export function pinnedWriteRefusal(
  store: Pick<Store, "get">, ownerName: string, isOwner: boolean, key: string, data: Record<string, unknown>,
): string | null {
  if (isOwner) return null;
  // The list of pins is the owner's own record; nobody else writes it, whatever it would say.
  if (key === pinsKey) return "Pinning a setting is the owner's alone.";
  // A write is allowed through only while it leaves every pinned field of this record exactly where
  // the owner pinned it. Anything else — a new value, or a record that drops the field so it falls
  // back to something else — is the change the pin exists to refuse.
  for (const pin of pins(store, ownerName))
    if (pin.key === key && effectiveValue(pin, data) !== pin.value) return pinnedRefusal(pin);
  return null;
}
