import type { Store } from "../store.js";
import type { ContextBudget } from "../catalog.js";
import type { Usage } from "../contracts.js";
import { readSavings } from "./settings.js";

/**
 * R17-048: Branch decides when to fold a conversation from its own estimate of how big each
 * request is. The service says how big the request really was. With this card on, the ratio
 * between the two from the last round of the same task scales the estimate, but only upwards:
 * the measured size can make folding happen sooner, never later, so it can never switch folding
 * off by accident. A ratio (rather than the raw figure) keeps being right after a fold shrinks
 * the conversation, with nothing to reset.
 */
const ratios = new Map<string, number>();
const most = 4;

/** Called after each answered round with what was estimated and what the service reported. */
export function noteReported(runId: string, estimatedInput: number, reported: Usage | undefined): void {
  if (!reported || estimatedInput <= 0 || reported.input <= 0) return;
  if (ratios.size > 500) ratios.delete(ratios.keys().next().value!);
  ratios.set(runId, Math.min(most, reported.input / estimatedInput));
}

/** The latest ratio for one task, or null when the service has not said. */
export function reportedRatio(runId: string): number | null {
  return ratios.get(runId) ?? null;
}

/**
 * The budget with the measured conversation size in place of the estimate, when the card is on and
 * it is larger. Only the size the fold is decided on changes: the room left (`headroom`), which
 * decides whether a request is refused as too long, stays Branch's own estimate, so switching this
 * on can make a fold come sooner but can never make a task fail that did not fail before.
 */
export function withReported(store: Pick<Store, "get">, owner: string, runId: string, budget: ContextBudget): ContextBudget {
  if (readSavings(store, owner, "reportedTokens").mode !== "on") return budget;
  const ratio = reportedRatio(runId);
  if (ratio === null || ratio <= 1) return budget;
  return { ...budget, messages: Math.ceil(budget.messages * ratio) };
}
