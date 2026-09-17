import type { Proposal } from "../memory-review.js";

/**
 * Accepting a skill idea from the learning core. The idea carries the steps that kept working
 * (`learned.evidence`, in order) and the kind of request they worked for (`learned.source`). This
 * turns them into a first draft of a skill file for the existing skill editor to open. Nothing is
 * installed and nothing is switched on: the owner reads it, changes it, and installs it if they want.
 */
export interface SkillDraft { name: string; document: string; steps: string[] }

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "steps";
/** Tool names are plain identifiers; anything else is left out rather than written into a skill. */
const safeStep = (step: string): boolean => /^[A-Za-z0-9_.:-]{1,120}$/.test(step);

export function skillIdeaDraft(proposal: Proposal): SkillDraft {
  const steps = (proposal.learned?.evidence ?? []).filter(safeStep).slice(0, 8);
  if (steps.length < 2) throw new Error("That skill idea no longer lists the steps it came from");
  const said = (proposal.learned?.source ?? "").replace(/ requests$/, "").trim();
  const kind = /^[a-z][a-z -]{0,39}$/.test(said) ? said : "general";
  const name = `${slug(kind)}-steps`;
  const document = [
    "---",
    `name: ${name}`,
    `description: Steps that have kept working for ${kind} requests: ${steps.join(", then ")}.`,
    "---",
    "",
    `When a ${kind} request comes in, these steps have worked before, in this order:`,
    "",
    ...steps.map((step, at) => `${at + 1}. Use \`${step}\`.`),
    "",
    "Check the result before saying the work is done. Change these steps if the request needs something else.",
    "",
  ].join("\n");
  return { name, document, steps };
}
