import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * mac7/coding-next: read before edit, as Claude Code does. A model that changes a file it never
 * read writes from what it imagines the file says; the coding bench measured 15 of 15 edits refused
 * that way (docs/agents/coding-bench.md, window 4). With the owner's switch on, an edit, patch,
 * change set or whole-file write to a file that already exists is refused unless this task has read
 * that file since it last changed on disk — including a change somebody else made in between.
 *
 * What the task read is kept as a fingerprint of the file's text (never the text itself), per task,
 * and forgotten when the task ends. A new file needs no read. A file the task itself wrote counts as
 * read in its new form, taken after everything the call did (a formatter included), so the task's
 * own second edit is never refused. Tasks started outside a conversation (no task id) are not held.
 * While the switch is off nothing is noted or checked at all.
 */
export class ReadFirstError extends Error {
  override name = "ReadFirstError";
}

const fingerprint = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** At most this many tasks are remembered at once; a task that never said it ended cannot grow this forever. */
const taskLimit = 500;

export class ReadFirstGuard {
  private readonly tasks = new Map<string, Map<string, string>>();
  private readonly written = new Map<string, Set<string>>();
  /** `on` is asked at each check, so the owner's switch takes effect at once. */
  constructor(private readonly on: () => boolean) {}

  /** Paths compare the way the file system does: Windows ignores letter case. */
  private key(absolute: string): string {
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }
  private forTask(runId: string): Map<string, string> {
    let seen = this.tasks.get(runId);
    if (!seen) {
      if (this.tasks.size >= taskLimit) this.tasks.delete(this.tasks.keys().next().value!);
      seen = new Map();
      this.tasks.set(runId, seen);
    }
    return seen;
  }

  /** Whether this task is held to the rule right now; while it is not, callers skip the check entirely. */
  holds(runId: string): boolean {
    return !!runId && this.on();
  }

  /** The task read this file and was shown `content`. */
  noteRead(runId: string, absolute: string, content: string): void {
    if (runId && this.on()) this.forTask(runId).set(this.key(absolute), fingerprint(content));
  }

  /** Refuses, in one plain sentence, a change to an existing file this task has not read as it is now. */
  async require(runId: string, absolute: string, shown: string): Promise<void> {
    if (!runId || !this.on()) return;
    const now = await readFile(absolute, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (now === null) return;
    const read = this.tasks.get(runId)?.get(this.key(absolute));
    if (read === undefined)
      throw new ReadFirstError(`Nothing was changed: read "${shown}" with files.read first. This task has not read it yet, and a change made without reading the file can overwrite what is really there.`);
    if (read !== fingerprint(now))
      throw new ReadFirstError(`Nothing was changed: "${shown}" has changed since this task last read it. Read it again with files.read, then make the change.`);
  }

  /** The task wrote this file; it counts as read once the call has finished (see `settle`). */
  noteWritten(runId: string, absolute: string): void {
    if (!runId || !this.on()) return;
    const files = this.written.get(runId) ?? new Set<string>();
    files.add(absolute);
    this.written.set(runId, files);
  }

  /** After a call: every file it wrote is taken as read, as it is now on disk. */
  async settle(runId: string): Promise<void> {
    const files = this.written.get(runId);
    if (!files) return;
    this.written.delete(runId);
    for (const absolute of files) {
      const now = await readFile(absolute, "utf8").catch(() => null);
      if (now === null) this.tasks.get(runId)?.delete(this.key(absolute));
      else this.noteRead(runId, absolute, now);
    }
  }

  /** The task has ended. */
  forget(runId: string): void {
    this.tasks.delete(runId);
    this.written.delete(runId);
  }
}
