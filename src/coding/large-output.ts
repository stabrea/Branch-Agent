import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { codingOn } from "./settings.js";

/**
 * R17-041: a tool answer too long to hand the model (over 64 KiB) used to fail the call outright.
 * With this part switched on, the answer is kept in a file in Branch's own data folder instead, and
 * the model gets its start and a handle to read the rest a piece at a time with `output.read`
 * (after Goose's large-response handler, Apache-2.0, `crates/goose/src/agents/large_response_handler.rs`;
 * written for Branch). Secrets are hidden before anything is written, and old files are cleared.
 */
export const previewCharacters = 4000;
export const readPieceLimit = 32_000;
const keepDays = 7;
const keepPerOwner = 200;
/** The most of one answer that is ever kept (about 8 MB); the rest is cut and the note says so. */
export const maxKeptCharacters = 8_000_000;
const idPattern = /^[a-f0-9-]{36}$/;

export const OutputReadSchema = z.object({
  id: z.string().regex(idPattern, "Use the id the long answer came with"),
  offset: z.number().int().min(0).default(0),
  length: z.number().int().min(1).max(readPieceLimit).default(readPieceLimit),
}).strict();

export interface SavedOutput { savedOutput: string; tool: string; characters: number; preview: string; note: string }

export class LargeOutputs {
  constructor(private readonly store: Pick<Store, "get" | "folder">, private readonly owner: string,
    private readonly hide: (text: string) => string, private readonly now: () => number = Date.now) {}

  private folder(owner: string): string {
    return join(this.store.folder, "tool-output", createHash("sha256").update(owner).digest("hex").slice(0, 16));
  }

  /** The replacement answer, or undefined when the part is off and the call should fail as before. */
  keep(tool: string, result: unknown, context: Pick<ToolContext, "owner">): SavedOutput | undefined {
    if (!codingOn(this.store, this.owner, "large-output")) return undefined;
    const whole = this.hide(typeof result === "string" ? result : JSON.stringify(result, null, 1));
    const cut = whole.length > maxKeptCharacters;
    const text = cut ? whole.slice(0, maxKeptCharacters) : whole;
    const folder = this.folder(context.owner);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.tidy(folder);
    const id = randomUUID();
    writeFileSync(join(folder, `${id}.txt`), text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { savedOutput: id, tool, characters: text.length, preview: text.slice(0, previewCharacters),
      note: `This answer was too long to show whole. Read the rest with output.read using id ${id}, up to ${readPieceLimit} characters at a time.${cut ? ` Only the first ${maxKeptCharacters} of its ${whole.length} characters were kept.` : ""}` };
  }

  /** A piece of a kept answer. Only the person whose task kept it can read it. */
  async read(input: z.infer<typeof OutputReadSchema>, context: Pick<ToolContext, "owner">): Promise<{ id: string; offset: number; text: string; nextOffset: number | null; characters: number }> {
    const path = join(this.folder(context.owner), `${input.id}.txt`);
    const handle = await open(path, "r").catch(() => { throw new Error("There is no kept answer with that id. Kept answers are cleared after a week."); });
    try {
      const whole = await handle.readFile("utf8");
      const text = whole.slice(input.offset, input.offset + input.length);
      const end = input.offset + text.length;
      return { id: input.id, offset: input.offset, text, nextOffset: end < whole.length ? end : null, characters: whole.length };
    } finally {
      await handle.close();
    }
  }

  /** Drops files older than a week, and the oldest past the per-person limit. */
  private tidy(folder: string): void {
    const cutoff = this.now() - keepDays * 86_400_000;
    const entries = readdirSync(folder).filter((name) => name.endsWith(".txt"))
      .map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    entries.forEach((entry, index) => {
      if (entry.at < cutoff || index >= keepPerOwner - 1) rmSync(join(folder, entry.name), { force: true });
    });
  }
}

export function registerLargeOutput(registry: ToolRegistry, outputs: LargeOutputs): void {
  registry.register({
    name: "output.read", permission: "files.read", group: "code",
    description: "Read a piece of a tool answer that was too long to show whole, by the id it came with. nextOffset says where the next piece starts.",
    parameters: OutputReadSchema,
    execute: (input, context) => outputs.read(input, context),
  });
}
