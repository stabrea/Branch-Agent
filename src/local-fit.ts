import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { gb, type Hardware } from "./local-hardware.js";

/**
 * Wave mac5 (local models): will this model, at this size and with this much room for words,
 * run well on this computer right now?
 *
 * The figure that matters is memory that is free now, not memory installed. On a Mac with Apple
 * silicon the graphics share that memory, up to a ceiling the owner may have raised with
 * `sysctl iogpu.wired_limit_mb`; Branch cannot ask Metal itself for its limit without native code,
 * so when no ceiling is set it plans with free memory and says so. The free-memory sum on a Mac
 * follows Ollama's `discover/gpu_info_darwin.m` (MIT, see THIRD_PARTY_NOTICES.md).
 */
export type Run = (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
const run: Run = promisify(execFile);
const options = { timeout: 5000, windowsHide: true };

export interface MemoryReaders {
  platform?: string;
  run?: Run;
  readText?: (path: string) => Promise<string>;
  free?: () => number;
  total?: () => number;
}

/** Memory that could be handed to a model now, in bytes. Never more than is installed. */
export async function readFreeMemory(readers: MemoryReaders = {}): Promise<number> {
  const platform = readers.platform ?? process.platform;
  const total = (readers.total ?? totalmem)();
  const fallback = Math.min(total, (readers.free ?? freemem)());
  try {
    if (platform === "darwin") return parseVmStat((await (readers.run ?? run)("/usr/bin/vm_stat", [], options)).stdout, total) ?? fallback;
    if (platform === "linux") return parseMemAvailable(await (readers.readText ?? ((p) => readFile(p, "utf8")))("/proc/meminfo")) ?? fallback;
  } catch { /* the quick figure below is still true enough */ }
  return fallback;
}

/** `vm_stat`: total minus what is in use, counting purgeable and file-backed pages as free. */
export function parseVmStat(output: string, total: number): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(size) || size <= 0) return null;
  const pages = (label: string): number => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(output);
    return match ? Number(match[1]) : 0;
  };
  const used = (pages("Pages active") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages wired down")
    + pages("Pages occupied by compressor") - pages("Pages purgeable") - pages("File-backed pages")) * size;
  if (used <= 0) return null;
  return Math.max(0, total - used);
}

/** `/proc/meminfo`: the kernel's own "MemAvailable" estimate. */
export function parseMemAvailable(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * The most memory Apple silicon graphics may hold, when the owner has set it. Null means the
 * system default, which only Metal can report.
 */
export async function readAppleGraphicsLimit(readers: MemoryReaders = {}): Promise<number | null> {
  if ((readers.platform ?? process.platform) !== "darwin") return null;
  try {
    const { stdout } = await (readers.run ?? run)("/usr/sbin/sysctl", ["-n", "iogpu.wired_limit_mb"], options);
    const mb = Number(stdout.trim());
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 ** 2 : null;
  } catch { return null; }
}

/** Free memory and the graphics ceiling beside what `readHardware` already knows. */
export interface MachineRoom extends Hardware {
  freeMemoryBytes: number;
  graphicsLimitBytes: number | null;
}
let standIn: MemoryReaders | null = null;
/** Replaces how memory is asked for everywhere, so a test never starts `vm_stat` or `sysctl`. */
export function useMemoryReaders(readers: MemoryReaders | null): void { standIn = readers; }
export async function readRoom(hardware: Hardware, given: MemoryReaders = {}): Promise<MachineRoom> {
  const readers = standIn ? { ...given, ...standIn } : given;
  const [freeMemoryBytes, graphicsLimitBytes] = await Promise.all([readFreeMemory(readers), readAppleGraphicsLimit(readers)]);
  return { ...hardware, freeMemoryBytes, graphicsLimitBytes };
}

/* ---------- the estimate ---------- */

export interface Architecture { layers: number; kvHeads: number; headDim: number }
/** Bytes to hold the model's working notes for `context` words: two tables per layer, half-size numbers. */
export function contextBytes(arch: Architecture, context: number): number {
  return 2 * arch.layers * arch.kvHeads * arch.headDim * context * 2;
}
/**
 * Weights, plus the working notes for the chosen context, plus a tenth for everything else. This is
 * an estimate built from the figures each model publishes; the runtime's own planner is the
 * authority, and a load that does not fit fails there in plain words too.
 */
export function neededBytes(weightsBytes: number, arch: Architecture, context: number): number {
  return Math.round(weightsBytes * 1.1 + contextBytes(arch, context) + 256 * 1024 ** 2);
}

export type Fit = "well" | "tight" | "no";
export interface FitReport {
  fit: Fit;
  /** Bytes the estimate says the model needs at this context. */
  needsBytes: number;
  /** Where it would run fastest: the graphics, or the processor. */
  where: "graphics" | "processor" | "split";
  /** One short sentence for the screen. */
  note: string;
}

/** Room that is fast (graphics or shared memory), and room that is merely possible. */
function budget(room: MachineRoom): { fast: number; possible: number; where: FitReport["where"] } {
  const card = room.graphics;
  if (card?.sharedMemory) {
    const fast = room.graphicsLimitBytes ? Math.min(room.freeMemoryBytes, room.graphicsLimitBytes) : room.freeMemoryBytes;
    return { fast, possible: room.freeMemoryBytes, where: "graphics" };
  }
  if (card?.memoryBytes) return { fast: card.memoryBytes * 0.9, possible: card.memoryBytes * 0.9 + room.freeMemoryBytes * 0.8, where: "graphics" };
  return { fast: room.freeMemoryBytes * 0.85, possible: room.freeMemoryBytes, where: "processor" };
}

/** Fits well, tight, or won't fit, with the one sentence that explains it. */
export function judgeFit(room: MachineRoom, weightsBytes: number, arch: Architecture, context: number): FitReport {
  const needsBytes = neededBytes(weightsBytes, arch, context);
  const { fast, possible, where } = budget(room);
  const need = `about ${gb(needsBytes)} GB`;
  if (needsBytes <= fast)
    return { fit: "well", needsBytes, where, note: where === "graphics" ? `Fits well: needs ${need}, and your graphics can hold it.` : `Fits well: needs ${need} of free memory. It runs on the processor, so replies come steadily rather than fast.` };
  if (needsBytes <= possible)
    return { fit: "tight", needsBytes, where: where === "graphics" && !room.graphics?.sharedMemory ? "split" : where, note: `Tight: needs ${need}, which is close to what is free (${gb(fast)} GB fast). Expect slow replies.` };
  if (needsBytes <= room.totalMemoryBytes * 0.85)
    return { fit: "tight", needsBytes, where, note: `Tight: needs ${need} and only ${gb(room.freeMemoryBytes)} GB is free now. Closing other apps would help.` };
  return { fit: "no", needsBytes, where, note: `Won't fit: needs ${need}; this computer has ${gb(room.totalMemoryBytes)} GB in all.` };
}

const contextSteps = [32768, 16384, 8192, 4096] as const;
/**
 * The most room for words that still fits well, from 32,000 down to 4,000 and never above what the
 * model supports. When nothing fits well, the smallest that fits at all; when nothing fits, 4,000.
 */
export function chooseContext(room: MachineRoom, weightsBytes: number, arch: Architecture, maxContext: number): { context: number; report: FitReport } {
  const steps = contextSteps.filter((step) => step <= maxContext);
  const tries = (steps.length ? steps : [Math.max(2048, maxContext)]).map((context) => ({ context, report: judgeFit(room, weightsBytes, arch, context) }));
  return tries.find((entry) => entry.report.fit === "well")
    ?? [...tries].reverse().find((entry) => entry.report.fit === "tight")
    ?? tries[tries.length - 1]!;
}
