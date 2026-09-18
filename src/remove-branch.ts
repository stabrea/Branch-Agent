import { lstat, readdir, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { fetchedFolderNames, unixLayout, type UnixLayout, type UnixPlatform } from "./install/unix-install.js";
import { runUninstall, windowsRemoveNote, type ManageContext } from "./install/manage-cli.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { candidatePaths, runtimeIds, runtimeInfo, thisComputer, type Exists, type LaunchEnv } from "./local-launch.js";
import { currentPerson } from "./people/context.js";
import type { Store } from "./store.js";

/**
 * mac7/clean-uninstall: the danger zone — "Remove Branch and everything it installed".
 *
 * It shows what will go before anything goes, with real sizes: Branch itself, the folder holding
 * conversations and settings, the programs Branch fetched and the models they read, the entry that
 * starts Branch when you sign in, and the `branch` command. Anything a system installer put outside
 * Branch is named too, with the honest note that Branch cannot take it away again.
 *
 * It is the owner's alone, in the Branch app: a message from a chat app, a short-lived key (which
 * is also how another computer reaches this one), somebody else using this computer under their own
 * profile and a Trunk are each refused, because none of them can prove the owner is asking. And a
 * misclick cannot pass it: the owner types the product's own name, and hands back the exact survey
 * they were shown, so a yes can only ever agree to the list that was on the screen.
 *
 * Nothing is removed here that `branch uninstall` does not remove: this asks that same remover
 * (`src/install/manage-cli.ts`), which closes the running Branch first.
 */

/* ---------------------------------------------------------------- who may press it */

export const removeChatRefusal =
  "A message from a chat app cannot remove Branch from this computer: a chat cannot prove who is typing. Do it in the Branch app.";
export const removeShortLivedRefusal =
  "A short-lived key cannot remove Branch from this computer, and neither can another computer reaching this one. Do it in the Branch app.";
export const removeTrunkRefusal =
  "A Trunk cannot remove Branch from this computer. Only you can, in the Branch app.";
export const removePersonRefusal =
  "Removing Branch belongs to the owner. Switch back to the owner's profile to do it.";
export const removeStartedElsewhereRefusal =
  "Only you can remove Branch, in the Branch app. A schedule, a trigger or another AI tool cannot.";

export interface RemoveContext { source?: string | undefined; runId?: string | undefined; trunkKeys?: unknown }
type Events = { events(runId: string): { kind: string; data: Record<string, unknown> }[] };

/**
 * Why this caller may not remove Branch, or null. Deliberately not `installGuard`: removing is
 * still the owner's right when the switch that allows installing is off, and Lockdown must not
 * lock the owner out of taking Branch off their own computer.
 */
export function removalGuard(
  store: Pick<Store, "get"> & Partial<Events>, context: RemoveContext,
  person: string | null = currentPerson()?.profileId ?? null,
): string | null {
  const events = store as unknown as Events;
  const origin = context.runId && typeof events.events === "function" ? runOrigin(events, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey) return removeShortLivedRefusal;
  if (typeof events.events === "function" && startedFromChat(context, events)) return removeChatRefusal;
  if (context.trunkKeys) return removeTrunkRefusal;
  if (person || origin?.personProfileId || origin?.lentTo) return removePersonRefusal;
  if ((context.source ?? "owner") !== "owner" || (origin && origin.source !== "owner")) return removeStartedElsewhereRefusal;
  return null;
}

/* ---------------------------------------------------------------- what would go, and how big */

export interface RemovalItem {
  /** What it is, in plain words. */
  what: string;
  path: string;
  bytes: number;
  /** False for the folder of conversations and settings when the owner chooses to keep it. */
  goes: boolean;
}
export interface LeftBehindItem { what: string; path: string; why: string }
export interface RemovalSurvey {
  platform: string;
  /** Empty on a system where Branch cannot remove itself; then `instead` says what to do. */
  items: RemovalItem[];
  left: LeftBehindItem[];
  totalBytes: number;
  keptBytes: number;
  /** The owner types this, exactly, so a misclick cannot pass. The product's own name. */
  confirmPhrase: string;
  /** The survey as one line; the yes carries it back and only this survey is then carried out. */
  fingerprint: string;
  instead: string | null;
}

/** Every byte under a folder, walked here rather than shelled out to. Missing means zero. */
export async function folderBytes(path: string, seen = new Set<string>()): Promise<number> {
  const found = await lstat(path).catch(() => null);
  if (!found) return 0;
  if (found.isSymbolicLink()) return 0;
  if (!found.isDirectory()) return found.size;
  const key = `${found.dev}:${found.ino}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[]))
    total += await folderBytes(posix.join(path, name), seen);
  return total;
}

const notRemovable = (platform: string): string => platform === "win32"
  ? windowsRemoveNote : `Removing Branch from Settings is not available on ${platform}.`;
export const notInstalledHere =
  "This Branch is running from a folder you put there yourself, not from an installed copy, so there is nothing here to remove. Delete that folder to be rid of it.";

export interface SurveyDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /**
   * Whether this is an installed copy. A Branch started from a folder somebody built themselves has
   * no installer's work to undo, so the danger zone says so rather than offering to remove folders
   * it never put there. `BRANCH_INSTALL_ROOT` is what the installer's own `branch` command sets.
   */
  installed?: boolean;
  layout?: UnixLayout;
  at?: LaunchEnv;
  exists?: Exists;
  sizeOf?: (path: string) => Promise<number>;
}

/** What "Remove Branch and everything it installed" would take away on this computer, with sizes. */
export async function removalSurvey(deps: SurveyDeps, keepConversations = false): Promise<RemovalSurvey> {
  const nothing = { platform: deps.platform, items: [], left: [], totalBytes: 0, keptBytes: 0, confirmPhrase, fingerprint: "" };
  if (deps.platform !== "darwin" && deps.platform !== "linux")
    return { ...nothing, instead: notRemovable(deps.platform) };
  if (!(deps.installed ?? Boolean(deps.env.BRANCH_INSTALL_ROOT))) return { ...nothing, instead: notInstalledHere };
  const layout = deps.layout ?? unixLayout(deps.platform as UnixPlatform, deps.env);
  const size = deps.sizeOf ?? ((path: string) => folderBytes(path));
  const items = await surveyItems(layout, size, keepConversations);
  const left = await leftBehind(layout, deps);
  const totalBytes = items.filter((one) => one.goes).reduce((sum, one) => sum + one.bytes, 0);
  const keptBytes = items.filter((one) => !one.goes).reduce((sum, one) => sum + one.bytes, 0);
  return { platform: deps.platform, items, left, totalBytes, keptBytes, confirmPhrase,
    fingerprint: surveyFingerprint(items, keepConversations), instead: null };
}

async function surveyItems(layout: UnixLayout, size: (path: string) => Promise<number>, keep: boolean): Promise<RemovalItem[]> {
  const fetched = fetchedFolderNames.map((name) => posix.join(layout.dataDir, name));
  const own = await Promise.all(fetched.map(size));
  const dataTotal = await size(layout.userDataDir);
  const rows: RemovalItem[] = [
    { what: "Branch Agent itself", path: layout.installRoot, bytes: await size(layout.installRoot), goes: true },
    { what: "Programs Branch downloaded to run models", path: posix.join(layout.dataDir, "runners"), bytes: own[0] ?? 0, goes: true },
    { what: "Models Branch downloaded", path: posix.join(layout.dataDir, "models"), bytes: (own[1] ?? 0) + (own[3] ?? 0), goes: true },
    { what: "Downloads kept part-way through", path: posix.join(layout.dataDir, "local-installers"), bytes: own[2] ?? 0, goes: true },
    { what: "Your conversations and settings", path: layout.userDataDir, bytes: Math.max(0, dataTotal - own.reduce((a, b) => a + b, 0)), goes: !keep },
    { what: "Starting by itself when you sign in", path: layout.serviceFile, bytes: await size(layout.serviceFile), goes: true },
    { what: "The `branch` command", path: layout.launcher, bytes: await size(layout.launcher), goes: true },
  ];
  if (layout.menuEntry) rows.push({ what: "The applications-menu entry", path: layout.menuEntry, bytes: await size(layout.menuEntry), goes: true });
  return rows;
}

/**
 * What Branch will leave behind, named honestly: a copy of Branch somewhere its own installer did
 * not put it, and any program that runs models that lives outside Branch — because a system
 * installer put it there, or because the person installed it themselves.
 */
async function leftBehind(layout: UnixLayout, deps: SurveyDeps): Promise<LeftBehindItem[]> {
  const left: LeftBehindItem[] = [];
  const exists = deps.exists ?? (async (path: string) => stat(path).then(() => true, () => false));
  for (const root of layout.candidates)
    if (root !== layout.installRoot && await exists(root))
      left.push({ what: "A copy of Branch Agent", path: root,
        why: "This copy was not put there by Branch's own installer, so Branch leaves it alone. Remove it yourself if you want it gone." });
  const at = deps.at ?? thisComputer();
  for (const id of runtimeIds)
    for (const path of candidatePaths(id, at))
      if (await exists(path)) {
        left.push({ what: runtimeInfo[id].name, path,
          why: "This is outside Branch — a system installer put it there, or you installed it yourself — so Branch cannot remove it. Remove it the way you installed it." });
        break;
      }
  return left;
}

/** The product's own name: short, the same in every language, and no misclick ever types it. */
export const confirmPhrase = "Branch Agent";

function surveyFingerprint(items: RemovalItem[], keep: boolean): string {
  const facts = items.map((one) => `${one.path}|${one.goes ? 1 : 0}`).join("\n");
  return Buffer.from(`${keep ? "keep" : "all"}\n${facts}`).toString("base64url").slice(0, 43);
}

/* ---------------------------------------------------------------- carrying it out */

export const RemoveSchema = z.object({
  /** True keeps the folder holding conversations and settings; what Branch fetched still goes. */
  keepConversations: z.boolean().default(false),
  /** The product's own name, typed by the owner. */
  confirm: z.string().max(200),
  /** The survey the owner was shown, word for word. */
  agreedSurvey: z.string().max(64),
}).strict();

export const removeNotTypedNote =
  `Branch has not removed anything. Type ${confirmPhrase}, exactly, in the box to confirm.`;
export const removeSurveyChangedNote =
  "What would be removed has changed since you looked, so nothing was removed. Read the list again and confirm again.";

export interface RemoveDeps extends SurveyDeps {
  store: Store;
  owner: string;
  /** The version and folders this copy was started with; the remover needs them (manage-cli). */
  manage: ManageContext;
}
export interface RemoveOutcome { removed: boolean; message: string; lines: string[]; left: LeftBehindItem[] }

/**
 * Removes Branch and everything it installed. The survey is taken again first, so the owner's yes
 * is checked against what is really there now, not against what was on the screen a while ago.
 */
export async function removeBranch(input: unknown, deps: RemoveDeps, context: RemoveContext = {}): Promise<RemoveOutcome> {
  const wanted = RemoveSchema.parse(input ?? {});
  const refusal = removalGuard(deps.store, context);
  if (refusal) throw new Error(refusal);
  if (wanted.confirm.trim() !== confirmPhrase) throw new Error(removeNotTypedNote);
  const survey = await removalSurvey(deps, wanted.keepConversations);
  if (survey.instead) throw new Error(survey.instead);
  if (wanted.agreedSurvey !== survey.fingerprint) throw new Error(removeSurveyChangedNote);
  audit(deps.store, deps.owner, {
    action: "policy.changed", actor: deps.owner, subject: "removing Branch and everything it installed",
    reason: wanted.keepConversations ? "From the danger zone, keeping conversations and settings" : "From the danger zone, removing everything",
    outcome: "saved",
  });
  const outcome = await runUninstall(deps.manage, { deleteData: !wanted.keepConversations });
  if (!outcome.ok) throw new Error(outcome.lines.join(" "));
  return { removed: true, message: outcome.lines[0] ?? "Branch Agent has been removed.", lines: outcome.lines, left: survey.left };
}

/* ---------------------------------------------------------------- the two addresses */

export const handlesRemovePath = (path: string): boolean =>
  path === "/api/remove-branch" || path === "/api/remove-branch/plan";

const PlanSchema = z.object({ keepConversations: z.boolean().default(false) }).strict();

/**
 * `POST /api/remove-branch/plan` describes what would go; `POST /api/remove-branch` does it. Both
 * are the owner's alone (see `removalGuard`), and the plan only ever describes.
 */
export async function removeBranchApi(
  deps: RemoveDeps, method: string, path: string, body: () => Promise<unknown>, context: RemoveContext = {},
): Promise<unknown> {
  if (method !== "POST") throw new Error("Use POST");
  const refusal = removalGuard(deps.store, context);
  if (path === "/api/remove-branch/plan") {
    const { keepConversations } = PlanSchema.parse((await body()) ?? {});
    return { ...(await removalSurvey(deps, keepConversations)), refusal };
  }
  return removeBranch(await body(), deps, context);
}
