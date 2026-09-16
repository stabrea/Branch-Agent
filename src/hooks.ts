import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * Lifecycle hooks: small commands the owner registers to run when something happens (a task
 * finishes, a file changes, a memory suggestion arrives). A hook that keeps failing is switched
 * off after the configured number of failures so a broken script cannot slow every task; the owner
 * can switch it back on from Settings.
 */
export const hookEvents = ["run.finished", "run.check_failed", "tool.completed", "tool.failed", "file.changed", "delivery.sent", "content.flagged", "learning.reviewed", "attention.needed",
  // Batch 26 (wave 8): the one event that happens *before* something, so the hook can stop it.
  "tool.before"] as const;
export type HookEvent = (typeof hookEvents)[number];
/** What a hook asked for: hold the call for a yes, refuse it outright, or stay out of the way. */
export const HookVerdictSchema = z.object({
  decision: z.enum(["allow", "ask", "deny"]),
  reason: z.string().trim().max(300).default(""),
}).strict();
export type HookVerdict = z.infer<typeof HookVerdictSchema>;
/** A verdict with the hook that gave it, for the record and for what the person is shown. */
export interface HookDecision extends HookVerdict { hook: string }
const strictness: Record<HookVerdict["decision"], number> = { allow: 0, ask: 1, deny: 2 };
export const HookSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  event: z.enum(hookEvents),
  /** Name of an executable declared in the shell integration; hooks never run arbitrary paths. */
  executable: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  args: z.array(z.string().max(500)).max(20).default([]),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  /**
   * What to do when a hook that can stop a call takes too long or fails: hold the call for a yes,
   * which is the safe answer, or let it through. Only "tool.before" hooks ever use this.
   */
  onTimeout: z.enum(["allow", "ask"]).default("ask"),
}).strict();
export type HookConfig = z.infer<typeof HookSchema>;
export interface HookState { id: string; event: HookEvent; executable: string; enabled: boolean; failures: number; failureThreshold: number; runs: number; lastError: string | null; disabledAt: string | null }
export type HookRunner = (hook: HookConfig, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; verdict?: unknown }>;

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
  /**
   * Asks every "tool.before" hook whether a call may go ahead, and hands back the strictest answer.
   * A hook that says nothing, is switched off, or answers something that is not a verdict, leaves
   * the decision alone; one that takes longer than it was given, or fails, gives the answer its
   * `onTimeout` setting says, which is "ask" unless the owner chose otherwise. Every answer that
   * changes anything is written into the record of what the assistant was allowed to do.
   */
  async decide(runId: string, payload: Record<string, unknown>): Promise<HookDecision | null> {
    const hooks = [...this.hooks.values()].filter((hook) => hook.config.event === "tool.before" && hook.state.enabled);
    if (!hooks.length || !this.runner) return null;
    const answers = await Promise.all(hooks.map((hook) => this.askOne(hook, runId, payload)));
    const strictest = answers.filter((answer): answer is HookDecision => answer !== null)
      .sort((a, b) => strictness[b.decision] - strictness[a.decision])[0];
    if (!strictest || strictest.decision === "allow") return strictest ?? null;
    if (runId) this.store.event(runId, "hook.blocked", { hook: strictest.hook, decision: strictest.decision, reason: strictest.reason, tool: payload.tool ?? "" });
    audit(this.store, this.owner, { action: "hook.blocked", actor: `the hook "${strictest.hook}"`,
      subject: String(payload.tool ?? "a tool call"), reason: strictest.reason || "no reason given",
      runId: runId || null, outcome: strictest.decision === "deny" ? "refused" : "held for a yes" });
    return strictest;
  }
  /** One hook's answer, with its own time limit; nothing here can throw into the task. */
  private async askOne(hook: { config: HookConfig; state: HookState }, runId: string, payload: Record<string, unknown>): Promise<HookDecision | null> {
    const fallback: HookDecision | null = hook.config.onTimeout === "ask"
      ? { hook: hook.config.id, decision: "ask", reason: `The check "${hook.config.id}" did not answer in time, so this is being put to you instead.` }
      : null;
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), hook.config.timeoutMs + 500).unref());
    const asked = this.runOne(hook, runId, { event: "tool.before", ...payload })
      .then((outcome) => outcome ?? null).catch(() => undefined);
    const outcome = await Promise.race([asked, timed.then(() => undefined)]);
    if (outcome === undefined || outcome === null) return fallback;
    const verdict = HookVerdictSchema.safeParse(outcome.verdict);
    if (!outcome.ok) return fallback;
    return verdict.success ? { hook: hook.config.id, ...verdict.data } : null;
  }
  /** Waits for hooks started so far, for tests and shutdown. */
  async settle(): Promise<void> { await Promise.allSettled([...this.inFlight]); }
  private async runOne(hook: { config: HookConfig; state: HookState }, runId: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; verdict?: unknown }> {
    hook.state.runs++;
    const outcome = await this.runner!(hook.config, { event: hook.config.event, runId, ...payload }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (outcome.ok) { hook.state.failures = 0; hook.state.lastError = null; this.persist(hook.state); return outcome; }
    hook.state.failures++; hook.state.lastError = (outcome.error ?? "failed").slice(0, 300);
    const disabled = hook.state.failures >= hook.config.failureThreshold;
    if (disabled) { hook.state.enabled = false; hook.state.disabledAt = new Date().toISOString(); }
    this.persist(hook.state);
    if (runId) this.store.event(runId, disabled ? "hook.disabled" : "hook.failed", { hook: hook.config.id, failures: hook.state.failures, threshold: hook.config.failureThreshold, error: hook.state.lastError });
    return outcome;
  }
  private persist(state: HookState): void {
    this.store.save("settings", this.owner, `hook:${state.id}`, { enabled: state.enabled, failures: state.failures, lastError: state.lastError, disabledAt: state.disabledAt });
  }
}
