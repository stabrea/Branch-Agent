import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";
import { lockdownActive } from "../lockdown.js";
import { callerGuard, type PressContext } from "../local-one-button.js";
import { audit } from "../audit.js";
import type { Store } from "../store.js";

/**
 * mac7/adapt: the switch and who may press it.
 *
 * `/adapt` gets something this computer does not have. That is the owner's own step and nothing
 * else's, so it ships off and it asks every time. "Nothing can stop it" means nothing stops it once
 * the owner has agreed — never that it acts without agreement.
 *
 *   off          (the default) `/adapt` refuses in one sentence and offers nothing
 *   when-needed  it works, and it speaks only when something has actually stopped a task
 *   on           the same, and it also names what is missing and what would fix it before it is asked
 *
 * The caller checks are `installGuard`'s own, not a second copy: a chat message, a short-lived key
 * (which is also how another computer reaches this one), somebody else's profile, a Trunk, and work
 * a schedule or a trigger started are all refused, and so is everything while Lockdown is on. Where
 * the fix is installing a program, the work itself goes through the one button, which checks its
 * own switch again — so `/adapt` can never install a runner that the install switch forbids.
 */

export const adaptSetting = "adapt";
const SavedSchema = z.object({ mode: FeatureModeSchema.optional() }).loose();
export const AdaptSettingsSchema = z.object({ mode: FeatureModeSchema }).strict();

/** Whether Branch may work out what is missing and offer to get it. Off until the owner says so. */
export function adaptMode(store: Pick<Store, "get">, owner: string): FeatureMode {
  if (lockdownActive(store, owner)) return "off";
  const saved = SavedSchema.safeParse(store.get("settings", owner, adaptSetting)?.data ?? {});
  return saved.success ? (saved.data.mode ?? "off") : "off";
}

export function saveAdaptSettings(store: Store, owner: string, input: unknown): { mode: FeatureMode } {
  const { mode } = AdaptSettingsSchema.parse(input);
  store.save("settings", owner, adaptSetting, { mode });
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "whether Branch may get what a stopped task is missing",
    reason: `Changed from Settings to ${mode}`, outcome: "saved",
  });
  return { mode };
}

export const adaptOffRefusal =
  "Branch is not set up to get what a stopped task is missing. Turn that on in Settings, under \"Getting what a stopped task is missing\", first.";
export const adaptLockdownRefusal =
  "Lockdown is on, so nothing is fetched or installed on this computer. Turn Lockdown off in Settings to allow this again.";

/**
 * Why this caller may not use `/adapt`, or null. The switch is checked here; who is asking is
 * `callerGuard`'s answer — the very code the one button asks — reworded so the sentence names
 * `/adapt` rather than installing.
 */
export function adaptGuard(
  store: Parameters<typeof callerGuard>[0], owner: string, context: PressContext,
  person?: string | null,
): string | null {
  if (lockdownActive(store, owner)) return adaptLockdownRefusal;
  if (adaptMode(store, owner) === "off") return adaptOffRefusal;
  const caller = person === undefined ? callerGuard(store, context) : callerGuard(store, context, person);
  return caller ? caller.replace("install a program on this computer", "use /adapt")
    .replace("Installing a program on this computer belongs to the owner", "Using /adapt belongs to the owner") : null;
}
