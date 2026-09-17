import { z } from "zod";
import type { Store } from "./store.js";

/**
 * "Plan first, show me the plan, then act."
 *
 * Asking about one tool call at a time is not the same as agreeing what is going to happen. This
 * holds the small amount of state behind the difference: which of the two modes a conversation is
 * in, how far a task may go before it checks back, and the plain sentences the owner reads on the
 * plan card. The plan itself, and the working through of it, live in orchestration.ts; the stops
 * that come out of it are put through the same approval gate as everything else.
 *
 * Nothing here is on unless the owner turns it on. "Just do it" is the default everywhere and
 * behaves exactly as Branch always has.
 */
export const planModes = ["just-do-it", "show-plan"] as const;
export type PlanMode = (typeof planModes)[number];
/** How far a task carrying out an agreed plan may go before it checks back. */
export const autonomyChoices = ["every-step", "changes-only", "at-the-end"] as const;
export type Autonomy = (typeof autonomyChoices)[number];

export const PlanActSettingsSchema = z.object({
  /** "Just do it", or "Show me the plan first". */
  planMode: z.enum(planModes).default("just-do-it"),
  /** Check with me before every step, before steps that change something, or not until the end. */
  autonomy: z.enum(autonomyChoices).default("at-the-end"),
}).strict();
export type PlanActSettings = z.infer<typeof PlanActSettingsSchema>;

/** What each choice is called on screen, in the owner's own words and nobody else's. */
export const planModeWords: Record<PlanMode, string> = {
  "just-do-it": "Just do it",
  "show-plan": "Show me the plan first",
};
export const autonomyWords: Record<Autonomy, string> = {
  "every-step": "Check with me before every step",
  "changes-only": "Check with me before steps that change something",
  "at-the-end": "Do not check with me until the end",
};

const projectKey = (projectId: string): string => `plan-act:project:${projectId}`;
const sessionKey = (sessionId: string): string => `plan-act:session:${sessionId}`;
const read = (store: Store, owner: string, key: string): PlanActSettings | null => {
  const saved = store.get("settings", owner, key)?.data;
  if (!saved) return null;
  const parsed = PlanActSettingsSchema.safeParse(saved);
  return parsed.success ? parsed.data : null;
};

/** The project's own choice: what every conversation in it starts from. */
export function projectPlanAct(store: Store, owner: string, projectId: string): PlanActSettings {
  return read(store, owner, projectKey(projectId)) ?? PlanActSettingsSchema.parse({});
}
export function saveProjectPlanAct(store: Store, owner: string, projectId: string, input: unknown): PlanActSettings {
  const value = PlanActSettingsSchema.parse({ ...projectPlanAct(store, owner, projectId), ...(input as object ?? {}) });
  store.save("settings", owner, projectKey(projectId), { ...value });
  return value;
}
/**
 * What this conversation is doing: its own choice when it has made one, otherwise the project's.
 * `fromConversation` says which of the two answered, so the switch can show whether this
 * conversation has been set apart from the rest of the project.
 */
export function sessionPlanAct(
  store: Store, owner: string, sessionId: string, projectId: string,
): PlanActSettings & { fromConversation: boolean } {
  const mine = sessionId ? read(store, owner, sessionKey(sessionId)) : null;
  return mine ? { ...mine, fromConversation: true } : { ...projectPlanAct(store, owner, projectId), fromConversation: false };
}
export function saveSessionPlanAct(store: Store, owner: string, sessionId: string, projectId: string, input: unknown): PlanActSettings {
  const base = sessionPlanAct(store, owner, sessionId, projectId);
  const value = PlanActSettingsSchema.parse({ planMode: base.planMode, autonomy: base.autonomy, ...(input as object ?? {}) });
  store.save("settings", owner, sessionKey(sessionId), { ...value });
  return value;
}
/** Puts a conversation back on whatever the project says. */
export function clearSessionPlanAct(store: Store, owner: string, sessionId: string): void {
  store.delete("settings", owner, sessionKey(sessionId));
}

/** What one step of a plan says about itself, as far as anything outside the plan needs to know. */
export interface PlanStepLike { title: string; touches?: string | undefined; changes?: boolean | undefined }

/** One sentence on the plan card saying which steps change something, before the owner presses yes. */
export function riskSentence(steps: PlanStepLike[]): string {
  const risky = steps.map((step, at) => ({ step, at: at + 1 })).filter((entry) => entry.step.changes !== false);
  if (!risky.length) return "Nothing in this plan changes anything: every step only looks things up.";
  const named = risky.map((entry) => `step ${entry.at} (${entry.step.touches || entry.step.title})`);
  const count = risky.length === 1 ? "One step changes something" : `${risky.length} steps change something`;
  return `${count}: ${named.join(", ")}. Nothing else in the plan changes anything.`;
}

/**
 * Why a tool call is not what the agreed plan said this step would do, or null when it is. Only one
 * thing is claimed here, and it is claimed plainly: the step said it would change nothing, and this
 * would change something. Anything vaguer would stop honest work for no reason.
 */
export function offPlanDifference(
  step: PlanStepLike, at: number, about: { label: string; target: string; readOnly: boolean },
): string | null {
  if (about.readOnly || step.changes !== false) return null;
  const said = step.touches ? `only look at ${step.touches}` : `only "${step.title}"`;
  return `step ${at} of the plan you agreed said it would ${said} and change nothing, `
    + `but to carry on it now needs to ${about.label.toLowerCase()}, which the plan did not mention`;
}

/** The words of one command: the program's name, then its arguments, as the owner would read them. */
export function commandWords(args: unknown): string[] {
  const input = args as { executable?: unknown; args?: unknown } | null;
  const program = typeof input?.executable === "string" ? input.executable.trim() : "";
  if (!program) return [];
  const rest = Array.isArray(input?.args) ? input.args.filter((one) => typeof one === "string").map(String) : [];
  return [program, ...rest].slice(0, 40);
}
/**
 * Whether the second command is the first one being tried again — the same program, and at least
 * half the same words. A different program is a different job, not a correction.
 */
export function relatedCommand(failed: string[], next: string[]): boolean {
  if (!failed.length || !next.length || failed[0] !== next[0]) return false;
  const shared = next.filter((word) => failed.includes(word)).length;
  return shared >= Math.ceil(Math.max(failed.length, next.length) / 2);
}
/** What changed between the command that failed and the one now proposed, in plain words. */
export function commandDifference(failed: string[], next: string[]): string {
  const added = next.filter((word) => !failed.includes(word));
  const removed = failed.filter((word) => !next.includes(word));
  const parts: string[] = [];
  if (removed.length) parts.push(`without ${removed.join(" ")}`);
  if (added.length) parts.push(`with ${added.join(" ")}`);
  return parts.length ? `the same command ${parts.join(" and ")}` : "exactly the same command again";
}
/** What the owner is shown before a command that already failed is tried again. */
export function correctionLabel(failed: string[], next: string[]): string {
  return `"${failed.join(" ")}" did not work, so this would run "${next.join(" ")}" instead — `
    + commandDifference(failed, next);
}
