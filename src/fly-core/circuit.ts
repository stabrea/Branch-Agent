import type { KenyonCode } from "./encode.js";
import {
  baselineWeight, depressionRate, forgetHalfLifeDays, maximumWeightsPerSide, recoveryRate, traceDecayPerStep, traceFloor,
} from "./sizes.js";

/**
 * The output side of the mushroom body: for every action Branch can take (a tool, a skill, a
 * remembered fact) there is an "approach" output neuron and an "avoid" output neuron, each reading
 * every Kenyon cell through its own synapse.
 *
 * Learning follows the three-factor rule documented in the fly: a synapse changes only when its
 * Kenyon cell was active (factor one), the action was taken so its output side is eligible
 * (factor two), and a dopamine signal arrives (factor three). Dopamine *depresses* the active
 * synapses: punishment depresses the "approach" side (Hige et al. 2015) and reward depresses the
 * "avoid" side (Owald et al. 2015), so the balance tips the right way for that situation only.
 *
 * Simplification, stated plainly: the opposite side is allowed to recover towards its starting
 * strength at a slower rate, never beyond it. Bidirectional plasticity at these synapses has been
 * reported, but this is a model of the idea, not of its biochemistry.
 *
 * Weights are kept as their difference from the starting strength, and only where they differ, so
 * an action that has been used a few times costs a few hundred numbers rather than thousands.
 */
export type ActionKind = "tool" | "skill" | "memory";
export interface ActionState {
  action: string;
  kind: ActionKind;
  /** Kenyon cell → (weight − baseline) for the approach and avoid neurons; always ≤ 0. */
  approach: Map<number, number>;
  avoid: Map<number, number>;
  uses: number;
  /** Sum of the credited signals, for plain reporting. */
  net: number;
  /** Milliseconds since the epoch of the last change, for forgetting. */
  updatedAt: number;
}
export interface ActionUse { action: string; kind: ActionKind; step: number; failed?: boolean }
export interface Scored { action: string; kind: ActionKind; score: number; evidence: number; uses: number }

const dayMs = 86_400_000;
const tiny = 1e-4;
/**
 * A failed call is punished on its own, whatever the task as a whole came to: a task can finish
 * after working round a call that failed, and that call should not share in the reward.
 */
export const failedCallSignal = -0.6;

export const actionKey = (kind: ActionKind, action: string): string => `${kind}:${action}`;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** How much of a change learned `ageMs` ago is still there. */
export function retention(ageMs: number, halfLifeDays = forgetHalfLifeDays): number {
  return ageMs <= 0 ? 1 : 0.5 ** (ageMs / (halfLifeDays * dayMs));
}

/** Slow forgetting: every learned change relaxes towards the starting strength. */
export function relax(state: ActionState, now: number): void {
  const keep = retention(now - state.updatedAt);
  if (keep < 1)
    for (const side of [state.approach, state.avoid])
      for (const [cell, value] of side) {
        const next = value * keep;
        if (Math.abs(next) < tiny) side.delete(cell); else side.set(cell, next);
      }
  state.updatedAt = Math.max(state.updatedAt, now);
}

/** Keeps only the `limit` largest learned changes on one side; the faintest go first. */
export function prune(side: Map<number, number>, limit = maximumWeightsPerSide): void {
  if (side.size <= limit) return;
  const faintest = [...side].sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || a[0] - b[0]);
  for (const [cell] of faintest.slice(0, side.size - limit)) side.delete(cell);
}

/** Depress one side's active synapses and let the other side recover, by `strength` in [0, 1]. */
function plasticity(depressed: Map<number, number>, recovering: Map<number, number>, code: KenyonCode, strength: number): void {
  for (const cell of code) {
    const low = depressed.get(cell) ?? 0;
    const weight = baselineWeight + low;
    depressed.set(cell, clamp(low - depressionRate * strength * weight, -baselineWeight, 0));
    const high = recovering.get(cell) ?? 0;
    const back = high - recoveryRate * strength * high;
    if (Math.abs(back) < tiny) recovering.delete(cell); else recovering.set(cell, back);
  }
  prune(depressed);
  prune(recovering);
}

/** The three-factor update for one action: `signal` in [-1, 1], `eligibility` in [0, 1]. */
export function reinforce(state: ActionState, code: KenyonCode, signal: number, eligibility: number, now: number): void {
  relax(state, now);
  const strength = clamp(Math.abs(signal) * eligibility, 0, 1);
  if (strength > 0) {
    if (signal > 0) plasticity(state.avoid, state.approach, code, strength);
    else plasticity(state.approach, state.avoid, code, strength);
  }
  state.uses += 1;
  state.net += signal * eligibility;
}

/** Approach minus avoid, averaged over the active cells, with forgetting applied on the fly. */
export function scoreOf(state: ActionState, code: KenyonCode, now: number): { score: number; evidence: number } {
  if (!code.length) return { score: 0, evidence: 0 };
  const keep = retention(now - state.updatedAt);
  let sum = 0, touched = 0;
  for (const cell of code) {
    const a = state.approach.get(cell) ?? 0, v = state.avoid.get(cell) ?? 0;
    if (a !== 0 || v !== 0) touched += 1;
    sum += (a - v) * keep;
  }
  return { score: sum / code.length, evidence: touched / code.length };
}

/** How much credit a use gets, by how many steps it came before the end of the task. */
export function eligibilityOf(step: number, lastStep: number): number {
  return Math.max(traceFloor, traceDecayPerStep ** Math.max(0, lastStep - step));
}

export class Circuit {
  readonly actions = new Map<string, ActionState>();
  state(kind: ActionKind, action: string, now: number): ActionState {
    const key = actionKey(kind, action);
    let found = this.actions.get(key);
    if (!found) {
      found = { action, kind, approach: new Map(), avoid: new Map(), uses: 0, net: 0, updatedAt: now };
      this.actions.set(key, found);
    }
    return found;
  }
  /** Learns from one finished task; returns the states it changed. */
  learn(code: KenyonCode, uses: readonly ActionUse[], signal: number, now: number, scale = 1): ActionState[] {
    const lastStep = Math.max(0, ...uses.map((use) => use.step));
    return uses.map((use) => {
      const state = this.state(use.kind, use.action, now);
      const own = use.failed ? clamp(failedCallSignal + Math.min(0, signal), -1, 0) : signal;
      reinforce(state, code, own, eligibilityOf(use.step, lastStep) * scale, now);
      return state;
    });
  }
  /** Every known action of a kind, best first; unknown actions are not listed. */
  rank(code: KenyonCode, kind: ActionKind, now: number): Scored[] {
    const scored: Scored[] = [];
    for (const state of this.actions.values()) {
      if (state.kind !== kind) continue;
      const { score, evidence } = scoreOf(state, code, now);
      scored.push({ action: state.action, kind, score, evidence, uses: state.uses });
    }
    return scored.sort((a, b) => b.score - a.score || b.evidence - a.evidence || a.action.localeCompare(b.action));
  }
}
