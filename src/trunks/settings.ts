import { z } from "zod";
import type { Store } from "../store.js";
import { lockdownOverrides } from "../lockdown.js"; // mac7/lockdown-fix

/**
 * Bucket R17-A (wave mac7): Trunks, Branch's named long-lived agents. Each part has the owner's
 * three-way switch — off, when needed, on — kept in a settings record of its own, and every one
 * ships off, so a fresh install has no Trunks, no rooms and no messages between them.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const trunkParts = ["trunks", "rooms", "messages", "routines", "teach"] as const;
export type TrunkPart = (typeof trunkParts)[number];
export const TrunkPartSchema = z.enum(trunkParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type TrunkMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

/** The settings record a part's switch is kept in. */
export const trunkKey = (part: TrunkPart): string => `trunks-${part}`;

/** What each part is, in the owner's words, for the card and for a refusal. */
export const trunkLabels: Record<TrunkPart, string> = {
  trunks: "Trunks, your named assistants",
  rooms: "Rooms where Trunks talk together",
  messages: "Trunks messaging each other",
  routines: "Routines a Trunk owns",
  teach: "Teaching a Trunk by showing it once",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const trunkTools: Record<TrunkPart, readonly string[]> = {
  trunks: [],
  rooms: [],
  messages: ["trunk.message"],
  routines: [],
  teach: [],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const trunkToolFeatures: readonly (readonly [string, string, readonly string[]])[] = trunkParts
  .filter((part) => trunkTools[part].length > 0)
  .map((part) => [trunkKey(part), `${trunkLabels[part].charAt(0).toLowerCase()}${trunkLabels[part].slice(1)} is switched on`, trunkTools[part]] as const);

export function trunkMode(store: Pick<Store, "get">, owner: string, part: TrunkPart): TrunkMode {
  if (lockdownOverrides(store, owner, trunkKey(part))) return "off"; // mac7/lockdown-fix
  const saved = RecordSchema.safeParse(store.get("settings", owner, trunkKey(part))?.data ?? {});
  if (!saved.success) return "off";
  // Every other part needs Trunks themselves: with those off, nothing of theirs works either.
  if (part !== "trunks" && saved.data.mode !== "off" && trunkMode(store, owner, "trunks") === "off") return "off";
  return saved.data.mode;
}

export function allTrunkModes(store: Pick<Store, "get">, owner: string): Record<TrunkPart, TrunkMode> {
  return Object.fromEntries(trunkParts.map((part) => [part, trunkMode(store, owner, part)])) as Record<TrunkPart, TrunkMode>;
}

export function saveTrunkMode(store: Store, owner: string, part: TrunkPart, input: unknown): TrunkMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, trunkKey(part), { mode });
  return mode;
}

export class TrunkOffError extends Error {
  override name = "TrunkOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireTrunkPart(store: Pick<Store, "get">, owner: string, part: TrunkPart): void {
  if (trunkMode(store, owner, part) === "off")
    throw new TrunkOffError(`${trunkLabels[part]} is switched off. The owner can switch it on in Customize → Specialists, under Trunks.`);
}

/** Tools that run programs on the computer: a Trunk gets them only when its own switch allows it (T-15). */
export const commandPermissions: readonly string[] = ["shell.execute", "code.execute", "remote.execute", "process.manage"];
