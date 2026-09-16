import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Lifecycle hooks: small commands the owner registers to run when something happens (a task
 * finishes, a file changes, a memory suggestion arrives). A hook that keeps failing is switched
 * off after the configured number of failures so a broken script cannot slow every task; the owner
 * can switch it back on from Settings.
 */
export const hookEvents = ["run.finished", "run.check_failed", "tool.completed", "tool.failed", "file.changed", "delivery.sent", "content.flagged", "learning.reviewed", "attention.needed"] as const;
export type HookEvent = (typeof hookEvents)[number];
export const HookSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  event: z.enum(hookEvents),
  /** Name of an executable declared in the shell integration; hooks never run arbitrary paths. */
  executable: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  args: z.array(z.string().max(500)).max(20).default([]),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict();
export type HookConfig = z.infer<typeof HookSchema>;
export interface HookState { id: string; event: HookEvent; executable: string; enabled: boolean; failures: number; failureThreshold: number; runs: number; lastError: string | null; disabledAt: string | null }
export type HookRunner = (hook: HookConfig, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

export class Hooks {
  private readonly hooks = new Map<string, { config: HookConfig; state: HookState }>();
  private runner: HookRunner | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();
  constructor(private readonly store: Store, private readonly owner: string) {}
  /** Registers hooks from the integrations file; earlier disabled state is remembered per hook id. */
  configure(configs: unknown[], runner: HookRunner): HookState[] {
    this.runner = runner;
    this.hooks.clear();
    for (const raw of configs) {
      const config = HookSchema.parse(raw);
      const saved = this.store.get("settings", this.owner, `hook:${config.id}`)?.data as Partial<HookState> | undefined;
      this.hooks.set(config.id, { config, state: { id: config.id, event: config.event, executable: config.executable, enabled: saved?.enabled ?? true, failures: saved?.failures ?? 0,
        failureThreshold: config.failureThreshold, runs: 0, lastError: saved?.lastError ?? null, disabledAt: saved?.disabledAt ?? null } });
    }
    return this.list();
  }
  list(): HookState[] { return [...this.hooks.values()].map((h) => ({ ...h.state })); }
  /** Switches a hook back on after it was disabled for repeated failures. */
  enable(id: string): HookState {
    const hook = this.hooks.get(id);
    if (!hook) throw new Error("No such hook");
    Object.assign(hook.state, { enabled: true, failures: 0, lastError: null, disabledAt: null });
    this.persist(hook.state);
    return { ...hook.state };
  }
  /** Runs every enabled hook for the event; failures count toward the threshold, and nothing here can fail the task. */
  fire(event: string, runId: string, payload: Record<string, unknown>): void {
    for (const hook of this.hooks.values()) {
      if (hook.config.event !== event || !hook.state.enabled || !this.runner) continue;
      const pending = this.runOne(hook, runId, payload).catch(() => undefined);
      this.inFlight.add(pending); void pending.finally(() => this.inFlight.delete(pending));
    }
  }
  /** Waits for hooks started so far, for tests and shutdown. */
  async settle(): Promise<void> { await Promise.allSettled([...this.inFlight]); }
  private async runOne(hook: { config: HookConfig; state: HookState }, runId: string, payload: Record<string, unknown>): Promise<void> {
    hook.state.runs++;
    const outcome = await this.runner!(hook.config, { event: hook.config.event, runId, ...payload }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (outcome.ok) { hook.state.failures = 0; hook.state.lastError = null; this.persist(hook.state); return; }
    hook.state.failures++; hook.state.lastError = (outcome.error ?? "failed").slice(0, 300);
    const disabled = hook.state.failures >= hook.config.failureThreshold;
    if (disabled) { hook.state.enabled = false; hook.state.disabledAt = new Date().toISOString(); }
    this.persist(hook.state);
    if (runId) this.store.event(runId, disabled ? "hook.disabled" : "hook.failed", { hook: hook.config.id, failures: hook.state.failures, threshold: hook.config.failureThreshold, error: hook.state.lastError });
  }
  private persist(state: HookState): void {
    this.store.save("settings", this.owner, `hook:${state.id}`, { enabled: state.enabled, failures: state.failures, lastError: state.lastError, disabledAt: state.disabledAt });
  }
}
