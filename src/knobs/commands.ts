import type { Store } from "../store.js";
import { readKnobs } from "./settings.js";
import { passedEnvironment } from "./environment.js";

/**
 * R17-S10: what a command gets from the owner's "Commands" card. Read fresh for every command, so a
 * change applies to the next one without restarting Branch.
 */
type Reader = Pick<Store, "get">;

export function commandTuning(store: Reader, owner: string, source: NodeJS.ProcessEnv): { timeoutMs: number | null; env: Record<string, string> } {
  const knobs = readKnobs(store, owner, "commands");
  return {
    timeoutMs: knobs.commandTimeoutSeconds === null ? null : knobs.commandTimeoutSeconds * 1000,
    env: passedEnvironment(knobs.passEnvironment, source),
  };
}

/** Throws the one plain sentence a switched-off kept-open command line answers with. */
export function keptOpenShellAllowed(store: Reader, owner: string): void {
  if (!readKnobs(store, owner, "commands").keptOpenShell)
    throw new Error("Keeping a command line open is switched off. Run each command on its own, or ask the owner to switch it on in Settings, Computer.");
}
