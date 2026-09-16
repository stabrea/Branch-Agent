import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { promisify } from "node:util";

/**
 * What this computer can actually run. Memory and processor cores come from Node itself; the
 * graphics card is asked for once through Windows and then remembered, because that question is
 * slow and the answer does not change while the app is open.
 */
export interface GraphicsCard {
  name: string;
  /** Video memory in bytes, or null when Windows does not report a believable figure. */
  memoryBytes: number | null;
}
export interface Hardware {
  totalMemoryBytes: number;
  cores: number;
  graphics: GraphicsCard | null;
  /** Plain-language summary for the screen, for example "16 GB memory, 8 cores, NVIDIA RTX 3060". */
  summary: string;
}

const gigabyte = 1024 ** 3;
export const gb = (bytes: number): number => Math.round((bytes / gigabyte) * 10) / 10;

const run = promisify(execFile);
/** Asks Windows for the graphics card once; anything unexpected simply means "no card reported". */
export async function readGraphicsCard(
  exec: (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }> = run,
  platform: string = process.platform,
): Promise<GraphicsCard | null> {
  if (platform !== "win32") return null;
  const script = "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress";
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "null") as { Name?: unknown; AdapterRAM?: unknown } | null;
    if (!parsed || typeof parsed.Name !== "string" || !parsed.Name.trim()) return null;
    const ram = typeof parsed.AdapterRAM === "number" && parsed.AdapterRAM > 0 ? parsed.AdapterRAM : null;
    return { name: parsed.Name.trim().slice(0, 120), memoryBytes: ram };
  } catch {
    return null;
  }
}

let remembered: Hardware | null = null;
let asking: Promise<Hardware> | null = null;
/**
 * This computer's memory, cores and graphics card. The slow part is asked once and kept — and two
 * screens opening at the same moment share the one question rather than each starting PowerShell.
 */
export async function readHardware(options: { refresh?: boolean } = {}): Promise<Hardware> {
  if (remembered && !options.refresh) return remembered;
  if (asking && !options.refresh) return asking;
  asking = (async () => {
    const graphics = await readGraphicsCard();
    return (remembered = describeHardware({ totalMemoryBytes: totalmem(), cores: cpus().length || 1, graphics }));
  })().finally(() => { asking = null; });
  return asking;
}
/** Forgets the remembered graphics card, so the next read asks Windows again. Used by tests. */
export function forgetHardware(): void {
  remembered = null;
  asking = null;
}
/** Adds the plain-language summary to raw numbers. Pure, so a test can hand it any computer. */
export function describeHardware(input: Omit<Hardware, "summary">): Hardware {
  const card = input.graphics
    ? `${input.graphics.name}${input.graphics.memoryBytes ? ` (${gb(input.graphics.memoryBytes)} GB)` : ""}`
    : "no separate graphics card found";
  return { ...input, summary: `${gb(input.totalMemoryBytes)} GB memory, ${input.cores} processor cores, ${card}` };
}

export type LocalSize = "small" | "medium" | "large";
export interface LocalRecommendation {
  size: LocalSize;
  /** The name to type into Ollama, for example "llama3.2:3b". */
  model: string;
  /** Roughly how much space the download takes, in bytes. */
  downloadBytes: number;
  /** Roughly how much memory it needs free while it answers, in bytes. */
  needsMemoryBytes: number;
  /** True when this computer has room for it. */
  fits: boolean;
  /** What to expect, in plain words. */
  expectation: string;
  /** Why it was or was not suggested for this computer. */
  note: string;
}

/** The three sizes offered, smallest first, with what a person can expect from each. */
const catalogue: Omit<LocalRecommendation, "fits" | "note">[] = [
  {
    size: "small", model: "llama3.2:3b", downloadBytes: 2 * gigabyte, needsMemoryBytes: 6 * gigabyte,
    expectation: "Fast, and good for notes, tidying text and short answers. It will get long reasoning wrong.",
  },
  {
    size: "medium", model: "llama3.1:8b", downloadBytes: 5 * gigabyte, needsMemoryBytes: 12 * gigabyte,
    expectation: "A steady all-rounder: a few seconds a reply, sensible with everyday questions and short documents.",
  },
  {
    size: "large", model: "qwen2.5:14b", downloadBytes: 9 * gigabyte, needsMemoryBytes: 24 * gigabyte,
    expectation: "Slower, but much better at reasoning and longer documents. Expect to wait on a computer with no graphics card.",
  },
];

/**
 * Which local models this computer can run. A model needs its working memory free, and a graphics
 * card with enough video memory makes it comfortably faster, which the note says in plain words.
 */
export function recommendModels(hardware: Omit<Hardware, "summary">): LocalRecommendation[] {
  const vram = hardware.graphics?.memoryBytes ?? 0;
  return catalogue.map((entry) => {
    const fits = hardware.totalMemoryBytes >= entry.needsMemoryBytes;
    const onCard = vram >= entry.needsMemoryBytes / 2;
    const note = !fits
      ? `Needs about ${gb(entry.needsMemoryBytes)} GB of memory; this computer has ${gb(hardware.totalMemoryBytes)} GB, so it would crawl.`
      : onCard
        ? `Fits, and your graphics card can take most of the work, so it should feel quick.`
        : `Fits in memory. Without enough video memory it runs on the processor, so replies come a word at a time.`;
    return { ...entry, fits, note };
  });
}

/** The one to suggest first: the largest that fits, or the smallest when nothing really does. */
export function bestRecommendation(hardware: Omit<Hardware, "summary">): LocalRecommendation {
  const all = recommendModels(hardware);
  return [...all].reverse().find((entry) => entry.fits) ?? all[0]!;
}
