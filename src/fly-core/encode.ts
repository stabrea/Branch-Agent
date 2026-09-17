import { createHash } from "node:crypto";
import { toolTerms } from "../tool-index.js";
import { activeCells, channelsPerFeature, clawsPerCell, inputChannels, kenyonCells } from "./sizes.js";

/**
 * Turning a task's starting situation into a sparse Kenyon-cell code.
 *
 * The fly's mushroom body takes a few dozen input channels, spreads them over thousands of Kenyon
 * cells through random connections (Caron et al. 2013), and lets feedback inhibition keep only the
 * most strongly driven few percent active (Lin et al. 2014). Similar situations then share many
 * active cells and different ones share few, which is what lets learning about one situation stay
 * mostly out of the way of another.
 *
 * The code is built only from what is known when a task starts — the kind of request, its words,
 * the project, where it came from, and any skill pinned to it — so the same code is available both
 * for suggesting and, later, for learning from the outcome. The tools, skills and memories a task
 * ends up using are the *actions* the output side learns about (see circuit.ts).
 *
 * The words of a request are hashed straight away and never kept, as in src/tool-usage.ts.
 */
export interface TaskContext {
  prompt: string;
  project?: string;
  source?: string;
  pinnedSkills?: readonly string[];
}
export interface Feature { key: string; weight: number }
export type KenyonCode = readonly number[];

const kinds: [string, RegExp][] = [
  ["code", /\b(code|bug|function|test|compile|build|repo|commit|script|typescript|python|error)\b/i],
  ["writing", /\b(write|draft|essay|letter|email|rewrite|summari[sz]e|proofread|document)\b/i],
  ["research", /\b(research|find out|look up|search|compare|sources?|investigate)\b/i],
  ["data", /\b(data|table|chart|spreadsheet|csv|excel|numbers|plot|average)\b/i],
  ["files", /\b(files?|folders?|rename|move|copy|pdf|download)\b/i],
  ["schedule", /\b(calendar|schedule|remind|meeting|appointment|tomorrow)\b/i],
  ["messages", /\b(message|reply|telegram|discord|slack|send)\b/i],
];
/** The kind of request, from a few plain signal words. "general" when none match. */
export function requestKind(prompt: string): string {
  return kinds.find(([, pattern]) => pattern.test(prompt))?.[0] ?? "general";
}

/** The features of a starting situation, each group carrying about the same total weight. */
export function contextFeatures(context: TaskContext): Feature[] {
  const words = [...new Set(toolTerms(context.prompt))].slice(0, 16);
  const perWord = words.length ? 1.5 / Math.sqrt(words.length) : 0;
  return [
    { key: `kind:${requestKind(context.prompt)}`, weight: 1 },
    { key: `project:${context.project ?? "default"}`, weight: 0.6 },
    { key: `source:${context.source ?? "owner"}`, weight: 0.3 },
    ...words.map((word) => ({ key: `word:${word}`, weight: perWord })),
    ...(context.pinnedSkills ?? []).slice(0, 8).map((id) => ({ key: `skill:${id}`, weight: 0.8 })),
  ];
}

/** A 32-bit number from a string, stable across runs and machines. */
function hash32(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32LE(0);
}
/** A small seeded generator (mulberry32), so the random wiring is the same every launch. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fixed random wiring from input channels to Kenyon cells, derived entirely from a seed. The
 * seed is stored with the learned weights: a different wiring would make everything learned
 * unreadable, so it must never change for an owner once chosen.
 */
export class Expansion {
  private readonly clawChannel = new Uint16Array(kenyonCells * clawsPerCell);
  private readonly clawWeight = new Float32Array(kenyonCells * clawsPerCell);
  constructor(readonly seed: string) {
    const next = generator(hash32(`wiring:${seed}`));
    for (let at = 0; at < this.clawChannel.length; at += 1) {
      this.clawChannel[at] = Math.floor(next() * inputChannels);
      // Synapse sizes vary between claws; a graded weight also keeps ties between cells rare.
      this.clawWeight[at] = 0.5 + next() * 0.5;
    }
  }
  /** Input-channel activity for a set of features. */
  channels(features: readonly Feature[]): Float32Array {
    const activity = new Float32Array(inputChannels);
    for (const feature of features) {
      const next = generator(hash32(`feature:${this.seed}:${feature.key}`));
      for (let n = 0; n < channelsPerFeature; n += 1)
        activity[Math.floor(next() * inputChannels)]! += feature.weight * (0.5 + next() * 0.5);
    }
    return activity;
  }
  /** The active Kenyon cells for a situation: the most strongly driven few, in ascending order. */
  code(context: TaskContext): KenyonCode {
    const activity = this.channels(contextFeatures(context));
    const drive = new Float32Array(kenyonCells);
    for (let cell = 0; cell < kenyonCells; cell += 1) {
      let sum = 0;
      for (let claw = 0; claw < clawsPerCell; claw += 1) {
        const at = cell * clawsPerCell + claw;
        sum += activity[this.clawChannel[at]!]! * this.clawWeight[at]!;
      }
      drive[cell] = sum;
    }
    return winnersTakeMost(drive, activeCells);
  }
}

/** Feedback inhibition, simplified: the `count` most driven cells stay active, silent cells never do. */
export function winnersTakeMost(drive: Float32Array, count: number): KenyonCode {
  const order = [...drive.keys()].filter((cell) => drive[cell]! > 0)
    .sort((a, b) => drive[b]! - drive[a]! || a - b);
  return order.slice(0, count).sort((a, b) => a - b);
}

/** How many active cells two codes share, as a share of the code size. */
export function codeOverlap(a: KenyonCode, b: KenyonCode): number {
  if (!a.length || !b.length) return 0;
  const other = new Set(b);
  return a.filter((cell) => other.has(cell)).length / Math.max(a.length, b.length);
}
