import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * A way back to how things were, just before a set of changes was written. Until this existed a
 * change set was applied and, if it turned out wrong, the only way back was whatever Git already
 * held — which is nothing at all for work that was never saved.
 *
 * The mark is a real commit, made with `git stash create`, which builds a commit object out of the
 * working folder without touching the working folder, the index, or the shared stash list. It is
 * then written to a ref of Branch's own under `refs/branch/` so nothing else ever trips over it.
 * A folder that is not a repository gets no mark, and is told so plainly rather than refused.
 */
export interface GitRun {
  (cwd: string, args: string[], signal: AbortSignal): Promise<{ status: string; stdout: string; stderr: string; exitCode: number | null }>;
}

export const checkpointsKey = "git-checkpoints";
export const CheckpointSchema = z.object({
  id: z.string().min(1).max(64),
  /** The folder it was taken in, relative to the workspace. */
  folder: z.string().max(300).default(""),
  /** What was about to happen, in plain words: "writing 4 files". */
  label: z.string().max(200).default(""),
  /** The ref the mark lives on, always under refs/branch/. */
  ref: z.string().min(1).max(200),
  commit: z.string().min(7).max(64),
  createdAt: z.string().min(1).max(40),
}).strict();
export type GitCheckpoint = z.infer<typeof CheckpointSchema>;
const ListSchema = z.object({ marks: z.array(CheckpointSchema).max(50).default([]) }).strict();

/** Most marks kept; the oldest goes when a new one arrives, so this never grows without bound. */
export const maxCheckpoints = 20;

export class GitCheckpoints {
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly run: GitRun,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): GitCheckpoint[] {
    const saved = ListSchema.safeParse(this.store.get("settings", this.owner, checkpointsKey)?.data ?? {});
    return saved.success ? saved.data.marks : [];
  }
  private write(marks: GitCheckpoint[]): void {
    this.store.save("settings", this.owner, checkpointsKey, { marks: marks.slice(0, maxCheckpoints) });
  }

  /** Whether this folder is a repository at all. Anything else is not an error, just a "no". */
  async isRepository(folder: string, signal: AbortSignal): Promise<boolean> {
    const out = await this.run(folder, ["rev-parse", "--is-inside-work-tree"], signal).catch(() => null);
    return out?.status === "completed" && out.stdout.trim() === "true";
  }

  /**
   * Marks how things are before a change set is written. Returns null when the folder is not a
   * repository, so whatever is applying the change can say so and carry on.
   */
  async before(folder: string, label: string, signal: AbortSignal): Promise<GitCheckpoint | null> {
    if (!(await this.isRepository(folder, signal))) return null;
    const made = await this.run(folder, ["stash", "create", label.slice(0, 100) || "before a change"], signal);
    // Nothing to keep means the folder is exactly as the last saved version: that version is the mark.
    const commit = made.stdout.trim() || (await this.run(folder, ["rev-parse", "HEAD"], signal)).stdout.trim();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return null;
    const id = `${commit.slice(0, 12)}-${this.now().getTime().toString(36)}`;
    const ref = `refs/branch/checkpoints/${id}`;
    const kept = await this.run(folder, ["update-ref", ref, commit], signal);
    if (kept.status !== "completed") return null;
    const mark: GitCheckpoint = { id, folder, label: label.slice(0, 200), ref, commit,
      createdAt: this.now().toISOString() };
    this.write([mark, ...this.list()]);
    audit(this.store, this.owner, { action: "policy.changed", actor: this.owner,
      subject: `a way back to before ${mark.label || "a change"}`,
      reason: "A mark was made before a set of changes was written, so it can be undone", outcome: "saved" });
    return mark;
  }

  /** Puts the folder back to how it was at a mark. The mark itself stays, so it can be used again. */
  async undo(id: string, signal: AbortSignal): Promise<{ folder: string; commit: string }> {
    const mark = this.list().find((entry) => entry.id === id);
    if (!mark) throw new Error("There is no saved way back with that name any more.");
    const out = await this.run(mark.folder, ["checkout", mark.commit, "--", "."], signal);
    if (out.status !== "completed" || out.exitCode !== 0)
      throw new Error("Git could not put those files back. Nothing was changed.");
    audit(this.store, this.owner, { action: "policy.changed", actor: this.owner,
      subject: `back to before ${mark.label || "a change"}`,
      reason: "The owner asked to go back to how things were before a set of changes", outcome: "done" });
    return { folder: mark.folder, commit: mark.commit };
  }

  /** Forgets a mark and lets Git collect the commit behind it. */
  async forget(id: string, signal: AbortSignal): Promise<boolean> {
    const mark = this.list().find((entry) => entry.id === id);
    if (!mark) return false;
    await this.run(mark.folder, ["update-ref", "-d", mark.ref], signal).catch(() => undefined);
    this.write(this.list().filter((entry) => entry.id !== id));
    return true;
  }
}

/**
 * A project may name a line of work. Switching to that project switches the folder to it, so "the
 * accounts" and "the website rewrite" are two projects rather than two things to remember to type.
 * A folder that is not a repository, or a line of work that does not exist, is said plainly and
 * changes nothing: switching project must never leave half-switched files behind.
 */
export class GitWorkspaces {
  constructor(private readonly checkpoints: GitCheckpoints, private readonly run: GitRun) {}

  /** Switches the folder to the project's line of work. Says what happened, in plain words. */
  async switchTo(folder: string, branch: string, signal: AbortSignal): Promise<{ switched: boolean; branch: string; reason: string }> {
    if (!branch) return { switched: false, branch: "", reason: "" };
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch))
      return { switched: false, branch, reason: `"${branch}" is not a name a line of work can have.` };
    if (!(await this.checkpoints.isRepository(folder, signal)))
      return { switched: false, branch, reason: "That project's folder is not a repository, so there is no line of work to switch to." };
    const dirty = await this.run(folder, ["status", "--porcelain"], signal);
    if (dirty.status === "completed" && dirty.stdout.trim())
      return { switched: false, branch, reason: "There are changes not saved yet in that folder, so the line of work was left alone. Save them first." };
    const out = await this.run(folder, ["switch", branch], signal);
    if (out.status !== "completed" || out.exitCode !== 0)
      return { switched: false, branch, reason: `There is no line of work called "${branch}" in that folder.` };
    return { switched: true, branch, reason: `Now working on "${branch}".` };
  }

  /** Which line of work the folder is on right now, or "" when it is not a repository. */
  async current(folder: string, signal: AbortSignal): Promise<string> {
    const out = await this.run(folder, ["rev-parse", "--abbrev-ref", "HEAD"], signal).catch(() => null);
    return out?.status === "completed" ? out.stdout.trim() : "";
  }
}
