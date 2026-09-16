import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import { CompletionCheckSchema, evaluateChecks } from "./reliability.js";

/**
 * A fixed evaluation suite: the same tasks with the same checks, run against the model choice in
 * use, with accuracy, latency and cost recorded from the actual runs. Energy is reported as
 * unavailable because nothing here can measure it honestly.
 */
export const EvaluationSuiteSchema = z.object({
  name: z.string().trim().min(1).max(80).default("Standard suite"),
  tasks: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), prompt: z.string().trim().min(1).max(4000), checks: CompletionCheckSchema }).strict()).min(1).max(20),
  model: z.string().max(64).optional(),
}).strict();
export type EvaluationSuite = z.infer<typeof EvaluationSuiteSchema>;
export interface EvaluationResult {
  id: string; name: string; preset: string; startedAt: string; finishedAt: string;
  tasks: { id: string; runId: string; status: string; passed: boolean; problem: string | null; ms: number; tokens: number }[];
  summary: { accuracy: number; passed: number; total: number; latencyMs: { mean: number; max: number }; tokens: number; energy: "unavailable" };
}
/** Three everyday tasks whose checks do not depend on a particular model's wording. */
export const standardSuite: EvaluationSuite = {
  name: "Standard suite",
  tasks: [
    { id: "arithmetic", prompt: "What is 17 multiplied by 23? Reply with the number only.", checks: { mustMatch: "\\b391\\b", maxRetries: 0 } },
    { id: "file-write", prompt: "Create a file named eval-note.txt in the workspace containing exactly the word ready, then say done.", checks: { files: ["eval-note.txt"], mustMention: ["done"], maxRetries: 0 } },
    { id: "json-shape", prompt: "Reply with a JSON object with keys city (string) and population (integer) for Lagos, Nigeria.", checks: { resultSchema: { type: "object", required: ["city", "population"], properties: { city: { type: "string" }, population: { type: "integer", minimum: 1 } } }, maxRetries: 0 } },
  ],
};

export class Evaluation {
  constructor(private readonly store: Store, private readonly owner: string) {}
  async run(runtime: Runtime, input: unknown = standardSuite): Promise<EvaluationResult> {
    const suite = EvaluationSuiteSchema.parse(input);
    const startedAt = new Date().toISOString();
    const tasks: EvaluationResult["tasks"] = [];
    for (const task of suite.tasks) {
      const began = Date.now();
      const run = await runtime.run({ prompt: task.prompt, checks: { ...task.checks, maxRetries: 0 }, ...(suite.model ? { model: suite.model } : {}) });
      const usage = this.store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number };
      const problem = run.status === "completed" ? await evaluateChecks(run.output, task.checks, runtime.workspace) : run.output.slice(0, 200);
      tasks.push({ id: task.id, runId: run.id, status: run.status, passed: run.status === "completed" && !problem, problem, ms: Date.now() - began, tokens: (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0) });
    }
    const passed = tasks.filter((t) => t.passed).length, latencies = tasks.map((t) => t.ms);
    const result: EvaluationResult = {
      id: randomUUID(), name: suite.name, preset: runtime.models.plan(this.owner, "evaluation", suite.model ? { preset: suite.model } : {}).choice.presetId,
      startedAt, finishedAt: new Date().toISOString(), tasks,
      summary: { accuracy: Math.round((passed / tasks.length) * 1000) / 1000, passed, total: tasks.length, latencyMs: { mean: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length), max: Math.max(...latencies) }, tokens: tasks.reduce((a, t) => a + t.tokens, 0), energy: "unavailable" },
    };
    this.store.save("governance", this.owner, `evaluation:${result.id}`, { ...result });
    return result;
  }
  list(): EvaluationResult[] {
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith("evaluation:")).map((r) => r.data as unknown as EvaluationResult).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
