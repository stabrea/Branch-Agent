import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const commitShape = /^[0-9a-f]{40}$/;

/** The commit a source checkout is at now, or null when git cannot say. */
export function checkoutHead(appPath: string): string | null {
  const answer = spawnSync("git", ["rev-parse", "HEAD"], { cwd: appPath, encoding: "utf8", timeout: 5000, windowsHide: true });
  const head = answer.status === 0 ? answer.stdout.trim() : "";
  return commitShape.test(head) ? head : null;
}

/**
 * The commit written into this build by scripts/package-desktop.mjs, or null for a copy built without one.
 * Q55: a copy running from its source code keeps an old dist/build-info.json across later builds, so there
 * the stamp is believed only when the checkout is still at that commit; otherwise it is "not recorded".
 */
export function builtFrom(appPath: string, packaged: boolean, headOf: (appPath: string) => string | null = checkoutHead): string | null {
  let commit: unknown;
  try { commit = JSON.parse(readFileSync(join(appPath, "dist", "build-info.json"), "utf8"))?.commit; } catch { return null; }
  if (typeof commit !== "string" || !commitShape.test(commit)) return null;
  return packaged || headOf(appPath) === commit ? commit : null;
}
