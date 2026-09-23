import { GitRunner } from "./integrations/git-run.js";
import { GitStatusSchema, type GitStatus } from "./collab-events.js";

/**
 * Reads a repository's current branch, head commit, clean flag and changed files straight from
 * Git, so publishing a patch (src/collab-events.ts) never asks the owner to type a commit id by
 * hand. Returns null for a folder that is not a repository, or one with no commits yet — there is
 * no head to report, so there is nothing to publish.
 */
export async function readGitStatus(git: GitRunner, folder: string, signal: AbortSignal): Promise<GitStatus | null> {
  const inside = await git.run({ cwd: folder, args: ["rev-parse", "--is-inside-work-tree"] }, signal).catch(() => null);
  if (inside?.status !== "completed" || inside.stdout.trim() !== "true") return null;
  const head = await git.run({ cwd: folder, args: ["rev-parse", "HEAD"] }, signal).catch(() => null);
  if (head?.status !== "completed" || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return null;
  const branch = await git.run({ cwd: folder, args: ["rev-parse", "--abbrev-ref", "HEAD"] }, signal).catch(() => null);
  const porcelain = await git.run({ cwd: folder, args: ["status", "--porcelain"] }, signal).catch(() => null);
  const changed = (porcelain?.status === "completed" ? porcelain.stdout : "")
    .split("\n").map((line) => line.slice(3).trim()).filter(Boolean).slice(0, 500);
  const parsed = GitStatusSchema.safeParse({
    branch: (branch?.status === "completed" && branch.stdout.trim()) || "HEAD",
    head: head.stdout.trim(), clean: changed.length === 0, changed,
  });
  return parsed.success ? parsed.data : null;
}

/** The patch for everything currently changed in the folder (working tree and index, against HEAD). */
export async function readGitDiff(git: GitRunner, folder: string, signal: AbortSignal): Promise<string> {
  const diff = await git.run({ cwd: folder, args: ["diff", "HEAD"], maxOutputBytes: 60000 }, signal).catch(() => null);
  return diff?.status === "completed" ? diff.stdout.slice(0, 60000) : "";
}
