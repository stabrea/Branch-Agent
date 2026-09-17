import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ignoreMatcher } from "../ignore.js";

/**
 * R17-S20: which ignore files hide paths from the assistant's searches.
 *
 * As always, `.branchignore` is used when there is one, and `.gitignore` otherwise. The owner can
 * stop `.gitignore` from being used at all, and name further files (such as `.aiignore`) whose
 * lines are added on top. A file that is missing is skipped.
 */
export interface IgnoreChoice { respectGitignore: boolean; extraIgnoreFiles: readonly string[] }
export const ignoreChoiceDefaults: IgnoreChoice = { respectGitignore: true, extraIgnoreFiles: [] };
type Ignores = (path: string, isDirectory?: boolean) => boolean;

async function matcherFor(base: string, name: string): Promise<Ignores | null> {
  if (/[/\\]/.test(name) || name === "." || name === "..") return null;
  try { return ignoreMatcher(await readFile(join(base, name), "utf8")).ignores; } catch { return null; }
}

/** The ignore rules in effect for a workspace folder, under the owner's choice. */
export async function ignoreRulesFor(base: string, choice: IgnoreChoice = ignoreChoiceDefaults): Promise<Ignores> {
  const main = (await matcherFor(base, ".branchignore"))
    ?? (choice.respectGitignore ? await matcherFor(base, ".gitignore") : null);
  const extra: Ignores[] = [];
  for (const name of choice.extraIgnoreFiles) {
    const found = await matcherFor(base, name);
    if (found) extra.push(found);
  }
  const all = [...(main ? [main] : []), ...extra];
  if (!all.length) return () => false;
  return (path, isDirectory) => all.some((ignores) => ignores(path, isDirectory));
}
