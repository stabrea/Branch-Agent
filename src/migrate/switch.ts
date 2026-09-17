import { z } from "zod";
import type { Store } from "../store.js";

/**
 * The owner's switch for moving in, which ships off like every feature.
 *
 * - **off**: Branch does not look at other assistants' folders at all, offers nothing, and refuses
 *   a preview or an import until the switch is changed.
 * - **when needed**: nothing is looked at on its own and the first-run card offers nothing; the
 *   owner can still look, and bring things over, by asking on the card.
 * - **on**: the usual places are checked when the card or the first-run card is shown, and the
 *   first-run card offers to bring things over.
 */
export const MoveInModeSchema = z.enum(["off", "when-needed", "on"]);
export type MoveInMode = z.infer<typeof MoveInModeSchema>;
const SwitchSchema = z.object({ mode: MoveInModeSchema }).strict();
const switchId = "move-in-switch";

export function moveInMode(store: Store, owner: string): MoveInMode {
  const saved = SwitchSchema.safeParse(store.get("settings", owner, switchId)?.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function saveMoveInMode(store: Store, owner: string, input: unknown): MoveInMode {
  const { mode } = SwitchSchema.parse(input);
  store.save("settings", owner, switchId, { mode });
  return mode;
}

/** Whether the owner may look or bring things over at all. */
export function requireMoveInAllowed(mode: MoveInMode): void {
  if (mode === "off") throw new Error("Moving in is switched off. Choose \"When needed\" or \"On\" under Settings first.");
}
