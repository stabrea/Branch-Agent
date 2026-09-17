/**
 * What to say when a task cannot be started where it was meant to go. Two things can be wrong: the
 * thing it needs is busy, or the thing it needs is not there at all. Neither should end in silence
 * or in a task that simply hangs, so every answer here carries a plain sentence saying what is in
 * the way and the next best thing the owner can actually do.
 *
 * This is about placing a task. A graph flow decides its own next step in its own file; nothing
 * here touches that.
 */
export type PlacementOutcome = "started" | "waiting" | "elsewhere" | "refused";

export interface Placement {
  outcome: PlacementOutcome;
  /** True only when the task is under way right now. */
  placed: boolean;
  /** One sentence for the owner: what happened and why. */
  reason: string;
  /** The next best thing, in the owner's words; null when there is nothing to offer. */
  alternative: string | null;
}

export interface PlacementFacts {
  /** How many tasks may work at once, and how many are working. */
  atOnce: number;
  running: number;
  /** Where this task is in the line, when it is waiting. */
  position?: number | null;
  /** Another task in the same conversation is already working. */
  sessionBusy?: boolean;
  /** A model preset the task asked for that is not set up on this computer. */
  missingPreset?: string | null;
  /** The model that will answer instead, when one can. */
  fallbackPreset?: string | null;
  /** Something the task needs that this computer does not have: a program, a backend, a service. */
  missing?: { what: string; instead: string | null } | null;
}

/** Whether the task can start this instant, and if not, what to tell the owner. */
export function placeTask(facts: PlacementFacts): Placement {
  const gone = refusedForMissing(facts);
  if (gone) return gone;
  const swapped = movedToAnotherModel(facts);
  if (swapped) return swapped;
  if (facts.sessionBusy)
    return { outcome: "waiting", placed: false,
      reason: "This conversation is already working on something, so this waits until that is done.",
      alternative: "Start it in a new conversation to have both run at once." };
  if (facts.running >= facts.atOnce)
    return { outcome: "waiting", placed: false,
      reason: `All ${facts.atOnce} places are taken, so this is ${placeInLine(facts.position)} in the line.`,
      alternative: "Stop something that is working to start this sooner, or raise how many may work at once in Settings." };
  return { outcome: "started", placed: true, reason: "There was room, so this started straight away.", alternative: null };
}

const placeInLine = (position: number | null | undefined): string =>
  typeof position === "number" && position > 0 ? `number ${position}` : "waiting";

/** Something the task needs is simply not here. Nothing is started and the owner is told why. */
function refusedForMissing(facts: PlacementFacts): Placement | null {
  if (!facts.missing) return null;
  return { outcome: "refused", placed: false,
    reason: `This needs ${facts.missing.what}, which is not on this computer.`,
    alternative: facts.missing.instead
      ? `You could use ${facts.missing.instead} instead.`
      : "Set it up in Settings and ask again; nothing was started." };
}

/** The model it asked for is gone, so another one answers and the swap is said out loud. */
function movedToAnotherModel(facts: PlacementFacts): Placement | null {
  if (!facts.missingPreset) return null;
  if (!facts.fallbackPreset)
    return { outcome: "refused", placed: false,
      reason: `The model "${facts.missingPreset}" is no longer set up, and there is no other one to use.`,
      alternative: "Add a model connection in Settings and ask again." };
  return { outcome: "elsewhere", placed: true,
    reason: `The model "${facts.missingPreset}" is no longer set up.`,
    alternative: `Using "${facts.fallbackPreset}" instead.` };
}

/** The whole thing in one line, for a log, an event or a command line. */
export function placementLine(placement: Placement): string {
  return placement.alternative ? `${placement.reason} ${placement.alternative}` : placement.reason;
}
