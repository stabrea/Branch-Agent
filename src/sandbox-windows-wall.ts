import { execFile } from "node:child_process";
import { statSync } from "node:fs";

/**
 * The Windows file restriction (wave mac3, os-sandbox). Everywhere else on Windows the wall changes
 * nothing (see the comment on `openWall` in sandbox-backends.ts): there is no bubblewrap, no
 * sandbox-exec, and building a real one — a restricted token, or an AppContainer — is a program of
 * its own. But the owner can already list places behind the wall may not even read (the "unreadable"
 * field on WallSettingsSchema, sandbox.ts); on macOS and Linux that list is enforced, and on Windows
 * it was silently ignored. This makes it real there too, the one piece Windows itself can enforce
 * without a container: a temporary deny rule, `icacls` already ships with Windows, needs no
 * elevation to deny an account access to a place it owns, and disappears the moment Branch removes
 * it, whether or not the program that ran under it ever touched the place.
 *
 * This is a file restriction, not a network or memory one — those are still the job object and the
 * dead-address proxy in sandbox.ts and code-run.ts. A place that does not exist yet needs nothing
 * denied, and is left out of the rule rather than failing the run.
 */

export interface WindowsFileRunResult { code: number | null }
export type WindowsFileRunner = (executable: string, args: readonly string[]) => Promise<WindowsFileRunResult>;

const runIcacls: WindowsFileRunner = (executable, args) => new Promise((resolvePromise) => {
  execFile(executable, args as string[], { windowsHide: true }, (error) => {
    resolvePromise({ code: error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : 1) : 0 });
  });
});

const kindOnDisk = (path: string): "dir" | "file" | null => {
  try { return statSync(path).isDirectory() ? "dir" : "file"; } catch { return null; }
};

/** `DOMAIN\name` for this computer's own account — the only one a deny rule is ever written for. */
export function windowsAccount(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.USERNAME;
  if (!name) throw new Error("The Windows file restriction needs an account name, and USERNAME is not set.");
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

export interface WindowsFileWall {
  /** Places the rule actually reached; a place that was not there needed nothing denied. */
  readonly denied: readonly string[];
  /** Takes the rule back off every one of them. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Puts a temporary deny-everything rule on each path, for this account, before a program runs behind
 * the wall. The caller removes it, with `close()`, once the program has ended — including when the
 * program never started at all, so a place is never left denied by a run that failed before it began.
 */
export async function denyWindowsPaths(
  paths: readonly string[],
  options: { account?: string; run?: WindowsFileRunner; kindOf?: (path: string) => "dir" | "file" | null } = {},
): Promise<WindowsFileWall> {
  const account = options.account ?? windowsAccount();
  const run = options.run ?? runIcacls;
  const kindOf = options.kindOf ?? kindOnDisk;
  const denied: string[] = [];
  for (const path of paths) {
    // The inherit flags (OI)(CI) exist to carry a rule down onto a folder's own children; put on a
    // plain file, icacls silently does nothing at all — the "Successfully processed" reads the same
    // either way, so a folder and a file each need their own rights string, never a fixed one.
    const kind = kindOf(path);
    const rights = kind === "file" ? "F" : "(OI)(CI)F";
    const result = await run("icacls", [path, "/deny", `${account}:${rights}`]);
    if (result.code === 0) denied.push(path);
    // A path icacls cannot reach (not there, or on a drive of its own) needed nothing hidden: the
    // program cannot read what is not there either way, and this is not the place to report that.
  }
  let closed = false;
  return {
    denied,
    async close() {
      if (closed) return;
      closed = true;
      for (const path of denied) await run("icacls", [path, "/remove:d", account]);
    },
  };
}
