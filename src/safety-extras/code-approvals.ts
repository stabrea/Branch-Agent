import { z } from "zod";
import { audit } from "../audit.js";
import { globMatches } from "../policy-resources.js";
import type { RunSource } from "../policy.js";
import type { Store } from "../store.js";
import { safetyMode } from "./settings.js";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp.js";

/**
 * mac7/r17-g (R17-063): chosen yeses need the six-digit code from the owner's authenticator app.
 *
 * The key lives only in the locker (encrypted, never returned by any route after the one moment it
 * is shown for the owner to add it to their app). Until the owner has typed back a first good code,
 * nothing is held, so a half-finished setup can never lock them out.
 *
 *   on           every tool on the list asks, even where a rule allows it, and a yes needs a code
 *   when-needed  the same, but only for work the owner did not start at the window (schedules,
 *                triggers, other AI tools), which is where nobody is watching
 *
 * A yes given with a code is bound to the exact request and never becomes a standing rule, and a
 * code is taken once: the same code cannot be used twice.
 */
export const codeProject = "branch-safety";
export const codeSecretName = "APPROVAL_CODE_KEY";
const setupKey = "safety-code-approvals-setup";
const markWindowMs = 5 * 60_000;
/** Integration review: at most this many wrong codes in a row, then every code waits out the window. */
export const maxWrongCodes = 5;
const wrongCodeWindowMs = 5 * 60_000;

export const CodeSetupSchema = z.object({
  /** Tools whose yes needs a code: a name, or a pattern with `*` ("payments.*"). */
  tools: z.array(z.string().trim().min(1).max(80)).max(64).default(["shell.execute", "payments.*", "email.send", "channels.send"]),
  /** Releasing the emergency stop needs a code too. */
  releaseNeedsCode: z.boolean().default(true),
}).strict();
export type CodeSetup = z.infer<typeof CodeSetupSchema>;
interface SavedSetup extends CodeSetup { enrolled: boolean; pending: boolean; lastCounter: number; wrong: number; wrongSince: number }

type Reader = Pick<Store, "get">;
function saved(store: Reader, owner: string): SavedSetup {
  const data = (store.get("settings", owner, setupKey)?.data ?? {}) as Partial<SavedSetup>;
  const parsed = CodeSetupSchema.safeParse({ tools: data.tools, releaseNeedsCode: data.releaseNeedsCode });
  const setup = parsed.success ? parsed.data : CodeSetupSchema.parse({});
  return { ...setup, enrolled: data.enrolled === true, pending: data.pending === true, lastCounter: Number(data.lastCounter ?? -1),
    wrong: Number(data.wrong ?? 0) || 0, wrongSince: Number(data.wrongSince ?? 0) || 0 };
}
const write = (store: Store, owner: string, value: SavedSetup): void => { store.save("settings", owner, setupKey, { ...value }); };

/** What the card shows. The key itself is never part of it. */
export function codeApprovalsView(store: Reader, owner: string): Omit<SavedSetup, "lastCounter" | "wrong" | "wrongSince"> & { mode: string } {
  const { lastCounter: _unused, wrong: _wrong, wrongSince: _since, ...view } = saved(store, owner);
  return { ...view, mode: safetyMode(store, owner, "code-approvals") };
}

export function saveCodeSetup(store: Store, owner: string, input: unknown): CodeSetup {
  const value = CodeSetupSchema.parse(input ?? {});
  write(store, owner, { ...saved(store, owner), ...value });
  return value;
}

/** Makes a new key, keeps it in the locker, and hands back the one link the owner's app reads. */
export async function beginCodeSetup(store: Store, owner: string): Promise<{ uri: string; key: string }> {
  const key = newTotpSecret();
  await store.locker.set(owner, codeProject, codeSecretName, key);
  write(store, owner, { ...saved(store, owner), enrolled: false, pending: true, lastCounter: -1 });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "Authenticator codes for approvals",
    reason: "A new authenticator key was made; it is not used until a first code is typed back", outcome: "saved" });
  return { uri: otpauthUri(key, owner), key };
}

/** True while too many wrong codes were typed lately: every code, even a right one, waits. */
export function codesResting(store: Reader, owner: string, now = Date.now()): boolean {
  const { wrong, wrongSince } = saved(store, owner);
  return wrong >= maxWrongCodes && now - wrongSince < wrongCodeWindowMs;
}
export const restingRefusal = "Too many wrong codes were typed. Wait five minutes, then use the next code from your app.";

function noteWrong(store: Store, owner: string): void {
  const now = Date.now(), setup = saved(store, owner);
  const fresh = now - setup.wrongSince >= wrongCodeWindowMs;
  write(store, owner, { ...setup, wrong: fresh ? 1 : setup.wrong + 1, wrongSince: fresh ? now : setup.wrongSince });
}

/**
 * Checks one code against the kept key, once. Integration review: wrong codes are counted (a
 * missing one is not), five in a row rest every code for five minutes, and the counter is read
 * again after the key is fetched, so two answers carrying the same code cannot both pass.
 */
export async function takeCode(store: Store, owner: string, code: unknown): Promise<boolean> {
  const setup = saved(store, owner);
  if (!setup.enrolled && !setup.pending) return false;
  if (typeof code !== "string" || !code.trim() || !store.locker.exists(owner, codeProject, codeSecretName)) return false;
  if (codesResting(store, owner)) return false;
  const key = (await store.locker.resolve(owner, codeProject, [codeSecretName]))[codeSecretName]!;
  const counter = matchTotp(key, code.trim());
  // Nothing is awaited from here on, so this read and the write below cannot be split by another answer.
  const now = saved(store, owner);
  if (counter === null || counter <= now.lastCounter || codesResting(store, owner)) { noteWrong(store, owner); return false; }
  write(store, owner, { ...now, lastCounter: counter, wrong: 0, wrongSince: 0 });
  return true;
}

/** True while codes guard this owner's yeses: an app is set up and the switch is not off. */
export function codesGuarding(store: Reader, owner: string): boolean {
  return saved(store, owner).enrolled && safetyMode(store, owner, "code-approvals") !== "off";
}
export const loosenCodeRefusal =
  "Changing or removing the authenticator codes needs the six-digit code from your app while they are on. Type it in the code field first.";

/**
 * Integration review: while codes guard the owner's yeses, taking that guard away (switching it
 * down, removing or replacing the app, changing the list) needs a good code too; otherwise one
 * call would undo the protection the code is there for.
 */
export async function requireCodeToLoosen(store: Store, owner: string, code: unknown): Promise<void> {
  if (!codesGuarding(store, owner)) return;
  if (await takeCode(store, owner, code)) return;
  throw new Error(codesResting(store, owner) ? restingRefusal : loosenCodeRefusal);
}

/** The first good code finishes the setup; from then on the listed yeses need one. */
export async function finishCodeSetup(store: Store, owner: string, code: unknown): Promise<boolean> {
  if (!saved(store, owner).pending || !(await takeCode(store, owner, code))) return false;
  write(store, owner, { ...saved(store, owner), enrolled: true, pending: false });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "Authenticator codes for approvals",
    reason: "The authenticator app was confirmed with a first code", outcome: "saved" });
  return true;
}

export function removeCodeSetup(store: Store, owner: string): void {
  try { store.locker.remove(owner, codeProject, codeSecretName); } catch { /* no locker in this launch */ }
  write(store, owner, { ...saved(store, owner), enrolled: false, pending: false, lastCounter: -1 });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "Authenticator codes for approvals",
    reason: "The authenticator app was removed; no yes needs a code now", outcome: "saved" });
}

/** True when releasing the emergency stop needs a code. */
export function releaseNeedsCode(store: Reader, owner: string): boolean {
  const setup = saved(store, owner);
  return setup.enrolled && setup.releaseNeedsCode && safetyMode(store, owner, "code-approvals") !== "off";
}

/** True when a yes to this tool needs a code, for work that came from `source`. */
export function needsCode(store: Reader, owner: string, tool: string, source: RunSource | string = "owner"): boolean {
  const mode = safetyMode(store, owner, "code-approvals");
  if (mode === "off") return false;
  const setup = saved(store, owner);
  if (!setup.enrolled || !setup.tools.some((pattern) => globMatches(pattern, tool))) return false;
  return mode === "on" || source !== "owner";
}

/** Requests a code was typed for, remembered for five minutes, per database. */
const marks = new WeakMap<object, Map<string, number>>();
const markKey = (sessionId: string, fingerprint: string | undefined): string => `${sessionId}\u0000${fingerprint ?? ""}`;

/** The owner typed a good code for this waiting request: its yes may now go through, once. */
export async function confirmWithCode(store: Store, owner: string, sessionId: string, fingerprint: string | undefined, code: unknown): Promise<boolean> {
  if (!(await takeCode(store, owner, code))) return false;
  const forStore = marks.get(store) ?? new Map<string, number>();
  forStore.set(markKey(sessionId, fingerprint), Date.now() + markWindowMs);
  marks.set(store, forStore);
  return true;
}

export const codeNeededRefusal =
  "This yes needs the six-digit code from your authenticator app. Type it on the question card in the app window, then answer again.";

/**
 * Called by `Runtime.approve` before a yes is kept. Throws when a code is needed and none was typed;
 * otherwise answers with how long the yes may be remembered (never as a standing rule).
 */
export function guardApproval(
  store: Reader, owner: string,
  waiting: { tool: string; source: string; fingerprint?: string | null | undefined },
  sessionId: string, decision: "allow" | "deny", remember: "never" | "session" | "always",
): "never" | "session" | "always" {
  if (decision === "deny" || !needsCode(store, owner, waiting.tool, waiting.source)) return remember;
  const forStore = marks.get(store), key = markKey(sessionId, waiting.fingerprint ?? undefined);
  const until = forStore?.get(key);
  forStore?.delete(key);
  if (!until || until < Date.now()) throw new Error(codeNeededRefusal);
  return remember === "always" ? "session" : remember;
}
