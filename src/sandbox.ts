/**
 * How tightly a program Branch Agent starts is held. Until this existed, the memory and processor
 * ceilings and the dead-address proxy were fixed per tool, and `src/code-run.ts` said outright that
 * what it offered was a limit on resources, not a sandbox the owner chooses. An approval rule can
 * now say which of the three it wants for the tools it covers, and the tool that starts the program
 * honours it.
 *
 * Nothing here is a security boundary on its own: a program still runs on this computer as this
 * user. It is the owner deciding how much rope one tool gets.
 */
export const sandboxChoices = ["no-internet", "limits-only", "none"] as const;
export type SandboxChoice = (typeof sandboxChoices)[number];

/** What one choice means for a program about to be started. */
export interface SandboxShape {
  /** Hand the program to Windows in a job, so the memory and processor ceilings are enforced. */
  job: boolean;
  /** Point the program at a dead address, so it cannot reach the internet. */
  netless: boolean;
}

const shapes: Record<SandboxChoice, SandboxShape> = {
  "no-internet": { job: true, netless: true },
  "limits-only": { job: true, netless: false },
  none: { job: false, netless: false },
};

/** Plain words for the settings screen and the approval card. */
export const sandboxSentences: Record<SandboxChoice, string> = {
  "no-internet": "in a box Windows holds to its memory and processor limits, with no way out to the internet",
  "limits-only": "in a box Windows holds to its memory and processor limits",
  none: "with no box around it",
};
export const sandboxSentence = (choice: SandboxChoice): string => sandboxSentences[choice];

/**
 * The shape to use: the owner's choice when a rule made one, otherwise exactly what the tool would
 * have done before this existed. A tool with no rule behaves as it always did.
 */
export function sandboxShape(choice: SandboxChoice | null | undefined, fallback: SandboxShape): SandboxShape {
  if (!choice) return fallback;
  // A rule may hold a program more tightly than the settings already do, never more loosely. If the
  // settings say this tool has no way out to the internet, no choice on a rule opens that way again:
  // the owner switched the internet off in one place and should not have it come back in another.
  return { job: shapes[choice].job, netless: shapes[choice].netless || fallback.netless };
}

/** The choice a shape amounts to, for reporting back what a program actually ran under. */
export function shapeChoice(shape: SandboxShape): SandboxChoice {
  return shape.job ? (shape.netless ? "no-internet" : "limits-only") : "none";
}
