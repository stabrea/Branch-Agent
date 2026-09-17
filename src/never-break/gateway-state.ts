import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "./gateway-config.js";

/**
 * What the gateway remembers between its own starts: whether it last stopped cleanly, and how the
 * worker has been crashing. Two ideas from Hermes (MIT, reimplemented): a "running" mark left behind
 * means the previous exit was not clean (`gateway/lifecycle_ledger.py`), and crashes are chained by
 * the gap between them rather than counted in a fixed window, so a slow crash loop is caught as
 * surely as a fast one (`gateway/restart_loop_guard.py`). Any trouble reading or writing this file
 * is ignored: it must never be the reason the gateway does not start.
 */
export const stateFile = "gateway-state.json";
const keepCrashes = 50;

const StateSchema = z.object({
  phase: z.enum(["running", "exited"]),
  pid: z.number().int(),
  changedAt: z.iso.datetime(),
  crashes: z.array(z.number()).max(keepCrashes),
}).strict();
export type GatewayState = z.infer<typeof StateSchema>;

export async function readState(dataDir: string): Promise<GatewayState | null> {
  try { return StateSchema.parse(JSON.parse(await readFile(join(dataDir, stateFile), "utf8"))); }
  catch { return null; }
}
async function writeState(dataDir: string, state: GatewayState): Promise<void> {
  await writeAtomic(join(dataDir, stateFile), JSON.stringify(state)).catch(() => undefined);
}

/** Marks the gateway running; answers whether the one before it stopped without saying so. */
export async function markRunning(dataDir: string, pid = process.pid): Promise<{ uncleanBefore: boolean; crashes: number[] }> {
  const before = await readState(dataDir);
  await writeState(dataDir, { phase: "running", pid, changedAt: new Date().toISOString(), crashes: before?.crashes ?? [] });
  return { uncleanBefore: before?.phase === "running", crashes: before?.crashes ?? [] };
}
export async function markExited(dataDir: string): Promise<void> {
  const before = await readState(dataDir);
  await writeState(dataDir, { phase: "exited", pid: process.pid, changedAt: new Date().toISOString(), crashes: before?.crashes ?? [] });
}

export interface CrashVerdict {
  /** How many crashes follow one another with no quiet gap longer than the limit. */
  chained: number;
  /** True once the chain is long enough that the gateway must slow down and stop carrying on work by itself. */
  tripped: boolean;
  /** How long to wait before the next worker. */
  delayMs: number;
}

/** Pure: the verdict for a list of crash times (milliseconds), newest last. */
export function crashVerdict(crashes: number[], limits: { maxQuickCrashes: number; gapSeconds: number }): CrashVerdict {
  let chained = crashes.length ? 1 : 0;
  for (let index = crashes.length - 1; index > 0; index--) {
    if (crashes[index]! - crashes[index - 1]! > limits.gapSeconds * 1000) break;
    chained++;
  }
  const tripped = chained >= limits.maxQuickCrashes;
  const delayMs = tripped ? 5 * 60_000 : chained === 0 ? 0 : Math.min(30_000, 500 * 2 ** (chained - 1));
  return { chained, tripped, delayMs };
}

/** Writes a crash down and answers what to do about it. */
export async function recordCrash(dataDir: string, limits: { maxQuickCrashes: number; gapSeconds: number }, at = Date.now()): Promise<CrashVerdict> {
  const before = await readState(dataDir);
  const crashes = [...(before?.crashes ?? []), at].slice(-keepCrashes);
  await writeState(dataDir, { phase: before?.phase ?? "running", pid: process.pid, changedAt: new Date(at).toISOString(), crashes });
  return crashVerdict(crashes, limits);
}
/** A worker that has stayed up long enough clears the chain. */
export async function clearCrashes(dataDir: string): Promise<void> {
  const before = await readState(dataDir);
  if (!before?.crashes.length) return;
  await writeState(dataDir, { ...before, crashes: [] });
}
