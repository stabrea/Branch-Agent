/**
 * Removing a temporary folder at the end of a test, on Windows, where it sometimes will not go.
 *
 * `rm(dir, { recursive: true, force: true })` ignores a folder that is already gone but not one
 * Windows still has a handle open on. A database file or a child process that has only just been
 * asked to close can hold one for a few milliseconds after the call that closed it returned, and
 * the removal then fails with EBUSY or ENOTEMPTY. Node's test runner counts a throw in an `after`
 * hook as the whole file failing, so a suite that passed every one of its assertions is reported
 * as broken — which has now happened, in five different suites, on work that had nothing to do
 * with any of them.
 *
 * Waiting briefly and asking again is the remedy. It is bounded, so a folder genuinely held open
 * by something still running is still reported rather than hidden: silently swallowing the error
 * would turn a real leak into a mystery later.
 */
import { rm } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

const holdsOn = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/** Removes a temporary folder, waiting out a handle Windows has not quite let go of yet. */
export async function discardTemp(dir, { tries = 12, pause = 50 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= tries || !holdsOn.has(error?.code)) throw error;
      await wait(pause);
    }
  }
}
