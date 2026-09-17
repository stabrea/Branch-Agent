import type { Store } from "../store.js";

/**
 * Background work the learning passes start after the owner said yes (writing a draft, trying it)
 * or after a task (looking back). Each job's outcome is written down so a failure is seen on the
 * card rather than lost, and `idle()` lets shutdown and tests wait for the work to finish.
 */
export interface JobOutcome { at: string; label: string; ok: boolean; detail: string }
const key = "reflection-jobs";
const kept = 20;

export class LearningJobs {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly store: Store, private readonly owner: string) {}
  start(label: string, work: () => Promise<string>): void {
    const job = work().then(
      (detail) => this.record({ label, ok: true, detail }),
      (error: unknown) => this.record({ label, ok: false, detail: error instanceof Error ? error.message : String(error) }),
    );
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  get running(): number { return this.pending.size; }
  recent(): JobOutcome[] {
    return ((this.store.get("settings", this.owner, key)?.data as { jobs?: JobOutcome[] } | undefined)?.jobs ?? []);
  }
  private record(outcome: Omit<JobOutcome, "at">): void {
    try {
      const jobs = [{ at: new Date().toISOString(), ...outcome, detail: outcome.detail.slice(0, 500) }, ...this.recent()].slice(0, kept);
      this.store.save("settings", this.owner, key, { jobs });
    } catch { /* the store may already be closed at shutdown; the outcome is only a note */ }
  }
}
