import { estimateCost, formatCost, pricingSettings, type CostEstimate } from "../pricing.js";
import type { Store } from "../store.js";

/**
 * mac7/learn: what building a map and writing a tour would cost, said before either is done.
 *
 * Understand Anything puts a whole codebase through a model and tells nobody what that costs,
 * before or after. Branch says it first and lets the owner stop, the way `KnowledgeCards.cost` and
 * `KnowledgePictures`' estimateOnly already do.
 *
 * The two honest answers are different and are kept apart on purpose:
 *
 *   A map costs nothing, because no model is called to build one — not "about zero", not a priced
 *   zero, but no model call at all. That is a sentence, not an estimate, and it never goes through
 *   `estimateCost`, because a figure of $0.00 would be indistinguishable from a model whose price
 *   nobody knows.
 *
 *   A tour's words are one model call, so that one does go through `estimateCost` and keeps
 *   everything that comes with it: a price from the table, a price the owner typed in, or no
 *   price at all — `amount: null`, printed as "no price on file", never as zero (src/pricing.ts).
 */

export interface LearnCost {
  /** What is being priced, in the owner's words. */
  what: string;
  /** How many times a model would be called. Zero for a map. */
  modelCalls: number;
  /** Null when nothing is charged because nothing is called, and when no price is on file. */
  estimate: CostEstimate | null;
  /** The whole thing as one sentence for the screen. */
  summary: string;
}

/** Roughly how many tokens a piece of text is, by the same four-characters-a-token rule used elsewhere. */
export const tokensIn = (text: string): number => Math.ceil(text.length / 4);

/**
 * Building a map: no model call, so no estimate and no figure. The sentence says how much work it
 * is in things a person can check — how many files or passages, and how many words — so "free" is
 * not the only thing they are told.
 */
export function mapCost(what: string, items: number, characters: number): LearnCost {
  return {
    what, modelCalls: 0, estimate: null,
    summary: `${items} ${items === 1 ? "part" : "parts"}, about ${tokensIn(String(characters ? "x".repeat(characters) : ""))
      .toLocaleString("en-GB")} words' worth. Building the map calls no model at all, so it costs nothing and nothing leaves this computer.`,
  };
}

/**
 * Writing a tour's words: one model call for the whole tour, priced through the one function that
 * is allowed to price anything. `model` empty means nothing is connected, which is its own answer.
 */
export function tourCost(store: Store, owner: string, model: string, steps: number, promptCharacters: number): LearnCost {
  const what = `the words for ${steps} ${steps === 1 ? "stop" : "stops"}`;
  if (!model)
    return { what, modelCalls: 0, estimate: null,
      summary: "No model is connected, so the tour is built from the map alone: every stop keeps its title and the passage it came from, and nothing is charged." };
  const usage = { input: tokensIn("x".repeat(promptCharacters)), output: steps * 90 };
  const estimate = estimateCost(model, usage, pricingSettings(store, owner).overrides);
  const money = estimate.amount === null
    ? "no price is on file for that model, so there is no figure to show"
    : `about ${formatCost(estimate)}`;
  return { what, modelCalls: 1, estimate,
    summary: `One call to ${model} writes ${what}: ${money}. The map itself is already built and cost nothing.` };
}
