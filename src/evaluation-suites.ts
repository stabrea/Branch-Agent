import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { CompletionCheckSchema } from "./reliability.js";
import { ScorerSchema } from "./evaluation-scorers.js";

/**
 * Evaluation suites kept as plain data, so a person can read one, copy it, and write their own
 * without touching the program. The five that ship live in `data/evaluation/*.json`; the owner's
 * own suites are saved alongside their other records and can be made from any past task.
 */
export const EvaluationTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  prompt: z.string().trim().min(1).max(8000),
  /** What a good answer looks like, in words. Shown to the judge; never a check on its own. */
  expected: z.string().trim().max(2000).optional(),
  /** Checks that can be decided without asking a model. When present these decide the result. */
  checks: CompletionCheckSchema.optional(),
  /** What must NOT happen. Always decided without a model, and always fatal when it happens. */
  deny: z.object({
    mentions: z.array(z.string().min(1).max(200)).max(20).default([]),
    files: z.array(z.string().min(1).max(500)).max(20).default([]),
  }).strict().optional(),
  /**
   * Wave 7: scorers, the small repeatable judgements in `evaluation-scorers.ts`. Every one must
   * pass. They run alongside `checks` and never replace them; see "Measuring the assistant".
   */
  scorers: z.array(ScorerSchema).max(8).optional(),
  /** Have the model in use grade a free-text answer from 0 to 1 and say why. */
  judge: z.object({
    rubric: z.string().trim().min(1).max(2000),
    pass: z.number().min(0).max(1).default(0.6),
  }).strict().optional(),
  /** Tools that must be installed. The task is skipped, not failed, when one of them is missing. */
  requires: z.array(z.string().min(1).max(100)).max(10).default([]),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
  /** Stop this task after this long. A single task can never run longer than two minutes. */
  timeoutMs: z.number().int().min(1000).max(120000).default(120000),
  /** "interrupt-resume" stops the task after its first step on purpose and then continues it. */
  mode: z.enum(["normal", "interrupt-resume"]).default("normal"),
}).strict();
export type EvaluationTask = z.infer<typeof EvaluationTaskSchema>;

export const SuiteSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(""),
  /** Every task only reads, so the suite is safe to run against several models for comparison. */
  readOnly: z.boolean().default(false),
  tasks: z.array(EvaluationTaskSchema).min(1).max(20),
}).strict();
export type Suite = z.infer<typeof SuiteSchema>;
export interface SuiteEntry extends Suite { source: "built-in" | "yours" }

const storeId = (id: string): string => `evaluation-suite:${id}`;

/** Where the suite files are: next to the built program when packaged, else the project's own folder. */
function suiteDirectories(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [join(here, "data", "evaluation"), join(here, "..", "data", "evaluation")];
}

/** The suites that ship with the program. A folder that is missing or damaged yields nothing. */
export function builtInSuites(): SuiteEntry[] {
  const found = new Map<string, SuiteEntry>();
  for (const directory of suiteDirectories()) {
    let names: string[];
    try { names = readdirSync(directory).filter((name) => name.endsWith(".json")); } catch { continue; }
    for (const name of names.sort()) {
      let contents: unknown;
      try { contents = JSON.parse(readFileSync(join(directory, name), "utf8")); }
      catch { throw new Error(`The evaluation suite ${name} is not readable JSON`); }
      const parsed = SuiteSchema.safeParse(contents);
      if (!parsed.success) throw new Error(`The evaluation suite ${name} is not valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
      if (!found.has(parsed.data.id)) found.set(parsed.data.id, { ...parsed.data, source: "built-in" });
    }
  }
  return [...found.values()];
}

/** Every suite the owner can run: the built-in ones first, then their own. */
export function allSuites(store: Store, owner: string): SuiteEntry[] {
  const mine = store.list("governance", owner)
    .filter((record) => record.id.startsWith("evaluation-suite:"))
    .flatMap((record) => {
      const parsed = SuiteSchema.safeParse(record.data);
      return parsed.success ? [{ ...parsed.data, source: "yours" as const }] : [];
    });
  return [...builtInSuites(), ...mine];
}

export function findSuite(store: Store, owner: string, id: string): SuiteEntry {
  const suite = allSuites(store, owner).find((entry) => entry.id === id);
  if (!suite) throw new Error(`There is no evaluation suite called ${id}`);
  return suite;
}

/** Saves one of the owner's own suites, replacing any earlier suite with the same name. */
export function saveSuite(store: Store, owner: string, input: unknown): SuiteEntry {
  const suite = SuiteSchema.parse(input);
  if (builtInSuites().some((entry) => entry.id === suite.id))
    throw new Error(`${suite.id} is the name of a suite that ships with the program; choose another`);
  store.save("governance", owner, storeId(suite.id), { ...suite });
  return { ...suite, source: "yours" };
}

export function removeSuite(store: Store, owner: string, id: string): { removed: boolean } {
  return { removed: store.delete("governance", owner, storeId(id)) };
}

export const FromRunSchema = z.object({
  runId: z.string().uuid(),
  /** The suite to add the task to; a new suite of the owner's own is made when it does not exist. */
  suite: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80).optional(),
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  checks: CompletionCheckSchema.optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
}).strict();

/**
 * Turns a task that already ran into a test. Without checks of your own, the answer it gave
 * becomes the reference answer and the first line of it must show up again.
 */
export function suiteFromRun(store: Store, owner: string, input: unknown): SuiteEntry {
  const request = FromRunSchema.parse(input);
  const run = store.run(request.runId);
  if (!run || run.owner !== owner) throw new Error("Run not found");
  if (run.status !== "completed") throw new Error("Only a task that finished can be turned into a test");
  const existing = allSuites(store, owner).find((entry) => entry.id === request.suite);
  if (existing?.source === "built-in") throw new Error(`${request.suite} ships with the program and cannot be added to`);
  const task = EvaluationTaskSchema.parse({
    id: request.taskId ?? `task-${(existing?.tasks.length ?? 0) + 1}`,
    prompt: run.prompt.slice(0, 8000),
    expected: run.output.slice(0, 2000),
    checks: request.checks ?? { mustMention: [firstPhrase(run.output)] },
    tags: request.tags,
  });
  const tasks = [...(existing?.tasks ?? []).filter((old) => old.id !== task.id), task];
  return saveSuite(store, owner, { id: request.suite, name: request.name ?? existing?.name ?? request.suite, description: existing?.description ?? "Made from tasks you ran.", tasks });
}

/** The first meaningful phrase of an answer, short enough to be a fair thing to look for again. */
function firstPhrase(output: string): string {
  const line = output.split("\n").map((part) => part.trim()).find((part) => part.length > 2) ?? output.trim();
  return line.slice(0, 80) || "ok";
}
