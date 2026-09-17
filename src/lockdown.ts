import { z } from "zod";
import type { Store } from "./store.js";
import { audit } from "./audit.js";

/**
 * One switch that shuts everything down at once. Turning Lockdown on makes every tool wait for the
 * owner's yes — the yeses already given for a conversation are ended too, by the route that sets it,
 * or an answer given earlier would keep standing in for the question — and switches off the things
 * that reach past this app on their own: running a script, leaving a program running, using the
 * screen and keyboard, borrowing the owner's browser, and sending anything out, which is both
 * messages and notes to other programs.
 *
 * What made it possible to turn back on again is the exact settings that were there before. They
 * are copied, untouched, into one kept record; turning Lockdown off writes those same settings back
 * and nothing else, so a switch that was already off before stays off afterwards. Both moments are
 * written into the record of what the assistant was allowed to do.
 */

/** The settings Lockdown takes over, and what it sets each one to while it is on. */
const guarded: readonly { key: string; locked: Record<string, unknown> }[] = [
  // Every tool, on anything, waits for a yes. The first matching rule wins, so one rule is enough.
  { key: "policy", locked: { preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "ask", remember: "never" }], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 } } },
  { key: "code-run", locked: { enabled: false } },
  // Programs the owner allows to be left running: with the list empty, process.start refuses by name.
  { key: "background-processes", locked: { programs: {} } },
  { key: "desktop-control", locked: { enabled: false } },
  { key: "browser-attach", locked: { enabled: false, runId: "", grantedAt: "" } },
];
const stateKey = "lockdown";

export const LockdownSchema = z.object({ on: z.boolean() }).strict();
export interface LockdownState {
  on: boolean;
  /** When it was turned on, so the rail can say how long it has been on. */
  since: string | null;
  /** In plain language, what is switched off while it is on. */
  effects: string[];
}
export const lockdownEffects = [
  "Every tool waits for your yes.",
  "Anything you already said yes to has to be asked again.",
  "Running a command or a script, and leaving a program running, are all off.",
  "Using your screen and keyboard is off.",
  "Borrowing your browser is off.",
  "Sending messages out and telling other programs what happened are both off.",
  "Automations that start by themselves, and routines a Trunk owns, are off, whatever they were set to.",
];

interface SavedLockdown { on: boolean; since: string | null; before: Record<string, Record<string, unknown> | null> }

function saved(store: Store, owner: string): SavedLockdown {
  const record = store.get("settings", owner, stateKey)?.data as unknown as SavedLockdown | undefined;
  return record && typeof record.on === "boolean" ? record : { on: false, since: null, before: {} };
}

/** Whether Lockdown is on, and what that stops. */
export function lockdownState(store: Store, owner: string): LockdownState {
  const current = saved(store, owner);
  return { on: current.on, since: current.since, effects: lockdownEffects };
}

/** True while Lockdown is on. The one question the sending paths ask before they send anything. */
export function lockedDown(store: Store, owner: string): boolean {
  return lockdownActive(store, owner);
}

/* ---------- mac7/lockdown-fix: Lockdown wins over any saved switch, read at the moment of use ---------- */

/**
 * The switches written above are only half of it: a feature with a saved mode ("on", "when
 * needed") reads its mode first, and a change saved while Lockdown is on would switch it back on.
 * So every covered feature also asks here each time it is read, and while Lockdown is on the answer
 * is "off" whatever was saved.
 */
type Reader = Pick<Store, "get">;

/** True while Lockdown is on; for the settings readers, which only hold a reader. */
export function lockdownActive(store: Reader, owner: string): boolean {
  const record = store.get("settings", owner, stateKey)?.data as { on?: unknown } | undefined;
  return record?.on === true;
}

/**
 * The settings records Lockdown switches off: the screen and keyboard, borrowing the browser,
 * running a script, every automation part, and routines a Trunk owns.
 * Devices and personal connectors add their record names here when they are merged.
 */
const coveredSettings: readonly RegExp[] = [
  /^desktop-control$/, /^browser-attach$/, /^code-run$/, /^autonomy-/, /^trunks-routines$/,
];

/** True when Lockdown is on and this settings record is one it switches off. */
export function lockdownOverrides(store: Reader, owner: string, key: string): boolean {
  return coveredSettings.some((pattern) => pattern.test(key)) && lockdownActive(store, owner);
}

/** Kinds of tool refused outright while Lockdown is on, rather than asked about. */
const refusedPermissions: readonly string[] = [
  "shell.execute", "code.execute", "remote.execute", "process.manage", "desktop.control", "desktop.view", "desktop.clipboard",
];
const refusedTools: readonly string[] = ["browser.borrow"];

export const lockdownToolRefusalText =
  "Lockdown is on, so commands, programs, your screen and keyboard, and your own browser are all off. Turn Lockdown off in Settings to allow this again.";

/** Why this tool is refused while Lockdown is on, or null. Checked in `Runtime.checkPolicy`. */
export function lockdownToolRefusal(store: Reader, owner: string, tool: string, permission: string): string | null {
  if (!refusedTools.includes(tool) && !refusedPermissions.includes(permission)) return null;
  return lockdownActive(store, owner) ? lockdownToolRefusalText : null;
}
/* ---------- end mac7/lockdown-fix ---------- */

/** The sentence a refused send gives back, so every place says the same thing. */
export const lockdownRefusal = "Lockdown is on, so nothing is being sent out. Turn it off in Settings to allow this again.";

/**
 * Turns Lockdown on or off. Turning it on copies the settings it is about to change and then
 * changes them; turning it off writes exactly those copies back — a setting that had never been
 * saved before is removed again rather than being given a made-up default.
 */
export function setLockdown(store: Store, owner: string, input: unknown): LockdownState {
  const { on } = LockdownSchema.parse(input);
  const current = saved(store, owner);
  if (on === current.on) return lockdownState(store, owner);
  if (on) turnOn(store, owner);
  else turnOff(store, owner, current);
  audit(store, owner, {
    action: "lockdown.changed", actor: owner, subject: on ? "Lockdown on" : "Lockdown off",
    reason: on
      ? "Every tool now waits for a yes; host programs, the screen, the browser and sending out are off"
      : "The settings that were in place before Lockdown were put back exactly as they were",
    outcome: "saved",
  });
  return lockdownState(store, owner);
}

function turnOn(store: Store, owner: string): void {
  const before: Record<string, Record<string, unknown> | null> = {};
  for (const entry of guarded) {
    const record = store.get("settings", owner, entry.key);
    before[entry.key] = record ? record.data : null;
    store.save("settings", owner, entry.key, { ...(record?.data ?? {}), ...entry.locked });
  }
  store.save("settings", owner, stateKey, { on: true, since: new Date().toISOString(), before });
}

function turnOff(store: Store, owner: string, current: SavedLockdown): void {
  for (const entry of guarded) {
    const was = current.before[entry.key];
    if (was === null || was === undefined) store.delete("settings", owner, entry.key);
    else store.save("settings", owner, entry.key, was);
  }
  store.save("settings", owner, stateKey, { on: false, since: null, before: {} });
}
