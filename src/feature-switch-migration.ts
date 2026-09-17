import type { Store } from "./store.js";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";

/**
 * The three-way switches ship off, but only for a new install. A computer that already had Branch
 * before the switches existed keeps doing what it did: the computer's own voice keeps reading aloud,
 * and a screen or Keychain switch that was ticked stays working. "When needed" is exactly how those
 * tools were offered before (tiered like any other), so that is what they become.
 *
 * This runs once per install, when the app starts. "Before the switches existed" means the database
 * was already on disk when this launch opened it; a fresh folder is a new install and keeps every
 * default off. A note in the owner's settings records that it ran, so it never runs twice and a
 * later choice of "off" is never undone.
 */
export const migrationKey = "feature-switches-migration";
const kept: FeatureMode = "when-needed";

type Settings = Record<string, unknown>;
const read = (store: Store, owner: string, key: string): Settings | undefined =>
  store.get("settings", owner, key)?.data;

/** The voice record gains the switch at "when needed" unless it already has one. */
function keepSystemVoice(store: Store, owner: string): void {
  const voice = read(store, owner, "voice");
  if (voice && FeatureModeSchema.safeParse(voice.systemVoice).success) return;
  store.save("settings", owner, "voice", { ...(voice ?? {}), systemVoice: kept });
}

/** A ticked yes/no switch with no mode is written down as "when needed"; anything else is left alone. */
function keepTickedSwitch(store: Store, owner: string, key: string): void {
  const saved = read(store, owner, key);
  if (!saved || saved.enabled !== true || saved.mode !== undefined) return;
  store.save("settings", owner, key, { ...saved, mode: kept });
}

/**
 * Runs the one-time step for this install. `existedBefore` is whether the database file was already
 * there before this launch opened it. The owner's profiles (people sharing this computer) that
 * already exist are carried over with the owner; profiles made later are new, and start off.
 */
export function migrateFeatureSwitches(store: Store, owner: string, existedBefore: boolean): { migrated: string[] } {
  if (read(store, owner, migrationKey)) return { migrated: [] };
  const owners = existedBefore
    ? [owner, ...store.profiles.list().map((profile) => `profile:${profile.id}`)]
    : [];
  for (const one of owners) {
    keepSystemVoice(store, one);
    keepTickedSwitch(store, one, "desktop-control");
    keepTickedSwitch(store, one, "keychain-entries");
  }
  store.save("settings", owner, migrationKey, { version: 1, existingInstall: existedBefore, at: new Date().toISOString() });
  return { migrated: owners };
}
