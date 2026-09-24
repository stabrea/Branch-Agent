import { z } from "zod";
import type { Trunk } from "./record.js";

/**
 * Q44 (DG-107): which computer a Trunk starts in. The choices are this computer (saved as null, or
 * left out altogether by a Trunk made before the setting existed) and the owner's paired computers
 * from the device book (src/devices/book.ts). A paired phone is a device but not a computer, and a
 * computer that is only asking to join is not paired yet, so neither is a choice.
 *
 * The setting is checked when it is saved: an id that is not one of the owner's computers is refused
 * and nothing is written. When a Trunk starts, the start path reads where it should start. This build
 * has no way to run a Trunk's turn on another computer, so a turn meant for one is refused in plain
 * words rather than quietly run here. `Trunks.startElsewhere` is where such a hop would plug in.
 */
export const StartsInSchema = z.string().regex(/^[a-f0-9]{16}$/, "Choose one of your computers").nullable();

/** One of the owner's computers, as the studio lists it. */
export interface Computer { id: string; name: string }
/** The owner's paired computers, read fresh each time. */
export type ComputersPort = () => Computer[];

/** The platforms a paired device must have to count as a computer (a phone never does). */
export const computerPlatforms: readonly string[] = ["darwin", "linux", "win32"];

/**
 * The refusal of a turn that cannot start here because its Trunk starts on another computer. Its own
 * class, so every route answers it with a 409 in these plain words (src/server.ts, src/flows-boards/api.ts).
 */
export class StartsElsewhereError extends Error {
  readonly status = 409;
}

/** Where a Trunk's turn starts: here, or on one of the owner's other computers. */
export type StartTarget = { where: "here" } | { where: "computer"; id: string; name: string };

/** A choice the owner does not have is refused with a 400, before anything is saved. */
export function checkStartsIn(value: string | null | undefined, computers: readonly Computer[]): void {
  if (value === null || value === undefined) return;
  if (computers.some((computer) => computer.id === value)) return;
  throw Object.assign(new Error("That computer is not one of yours. Choose This computer or one you have paired."), { status: 400 });
}

/**
 * Where the Trunk starts now. A computer that was paired when it was chosen but has since been
 * removed is refused rather than swapped for this one, so the owner's choice is never overruled.
 */
export function startTarget(trunk: Pick<Trunk, "startsIn">, computers: readonly Computer[]): StartTarget {
  if (!trunk.startsIn) return { where: "here" };
  const computer = computers.find((each) => each.id === trunk.startsIn);
  if (!computer) throw new StartsElsewhereError("This Trunk starts on a computer that is no longer paired. Choose where it starts again in Change look.");
  return { where: "computer", id: computer.id, name: computer.name };
}

/** The plain refusal for a turn meant for another computer when no way to start it there is wired. */
export const cannotStartThere = (name: string): StartsElsewhereError =>
  new StartsElsewhereError(`This Trunk starts on ${name}, and Branch cannot start a Trunk on another computer yet. Choose This computer under Starts in to talk to it here.`);

/**
 * A turn about to start or be queued here, for a Trunk set to start on another computer, is refused in
 * the plain words above (or the unpaired one's words), so nothing waits here for a start that never comes.
 */
export function requireStartsHere(trunk: Pick<Trunk, "startsIn">, computers: readonly Computer[]): void {
  const target = startTarget(trunk, computers);
  if (target.where === "computer") throw cannotStartThere(target.name);
}

/** How a turn would be handed to another computer; nothing in this build provides one. */
export type StartElsewhere = (target: { id: string; name: string }, trunk: Trunk, text: string) =>
  Promise<{ runId?: string; output?: string; status?: string }>;
