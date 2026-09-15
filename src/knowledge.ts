import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FanoutTaskSchema, ResultSchemaSchema, type FanoutTask } from "./delegation.js";
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import { executeTracedTool, type ToolSource } from "./tool-trace.js";

export const CheckSchema = z
  .object({ path: z.string().min(1).max(500), expected: z.string().max(32768) })
  .strict();
export const ProcedureSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(100),
    preconditions: z.array(CheckSchema).max(12),
    steps: z
      .array(
        z
          .object({
            tool: z.string().max(100),
            args: z.record(z.string(), z.unknown()),
            expected: z
              .unknown()
              .refine(
                (v) => v !== undefined,
                "An explicit expected result is required",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export const SpecialistSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(100),
    instructions: z.string().min(1).max(8000),
    permissions: z.array(z.string().max(100)).max(50),
    evaluation: z
      .object({
        prompt: z.string().min(1).max(8000),
        checks: z.array(CheckSchema).min(1).max(12),
      })
      .strict(),
  })
  .strict();
type Procedure = z.infer<typeof ProcedureSchema>;
type Specialist = z.infer<typeof SpecialistSchema>;
interface ProcedureVersion {
  version: number;
  definition: Procedure;
  status: "proposed" | "verified";
  verifiedAt?: string;
}
interface ProcedureState extends ProcedureVersion {
  history: ProcedureVersion[];
}
interface SpecialistVersion {
  version: number;
  definition: Specialist;
  evaluationPassed: boolean;
  evidence?: { runId: string; sourceRunId: string; checkedAt: string };
}
interface SpecialistState extends SpecialistVersion {
  activeVersion: number | null;
  previousActive: number | null;
  history: SpecialistVersion[];
}
const idArgs = z.object({ id: z.string().uuid() }).strict();

export class Knowledge {
  constructor(
    readonly store: Store,
    readonly registry: ToolRegistry,
    readonly runtime: Runtime,
  ) {}
  proposeProcedure(context: ToolContext, input: unknown): SavedRecord {
    this.require(context, "procedures.manage");
    const definition = ProcedureSchema.parse(input),
      id = definition.id ?? randomUUID();
    if (
      definition.steps.some(
        (s) =>
          s.tool.startsWith("procedures.") ||
          s.tool.startsWith("specialists.") ||
          s.tool.startsWith("schedules."),
      )
    )
      throw new Error("Recipes cannot invoke orchestration tools");
    const old = this.store.get("procedures", context.owner, id)
      ?.data as unknown as ProcedureState | undefined;
    const history = old
      ? [
          ...old.history,
          {
            version: old.version,
            definition: old.definition,
            status: old.status,
            ...(old.verifiedAt ? { verifiedAt: old.verifiedAt } : {}),
          },
        ]
      : [];
    return this.store.save("procedures", context.owner, id, {
      version: (old?.version ?? 0) + 1,
      definition,
      status: "proposed",
      history,
    });
  }
  async verifyProcedure(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    this.require(context, "procedures.manage");
    return this.runtime.auditOperation(context, "Verify procedure", (scoped) =>
      this.verifyCandidateProcedure(scoped, id),
    );
  }
  private async verifyCandidateProcedure(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    const record = this.required("procedures", context.owner, id),
      state = record.data as unknown as ProcedureState;
    await this.executeProcedure(context, state.definition, {
      kind: "procedure",
      id,
      version: state.version,
      phase: "step",
    });
    if (
      this.required("procedures", context.owner, id).data.version !==
      state.version
    )
      throw new Error("Procedure changed during verification");
    return this.store.save("procedures", context.owner, id, {
      ...state,
      status: "verified",
      verifiedAt: new Date().toISOString(),
    });
  }
  async replayProcedure(
    context: ToolContext,
    id: string,
  ): Promise<{ version: number; results: unknown[] }> {
    this.require(context, "procedures.use");
    return this.runtime.auditOperation(context, "Replay procedure", (scoped) =>
      this.replayVerifiedProcedure(scoped, id),
    );
  }
  private async replayVerifiedProcedure(
    context: ToolContext,
    id: string,
  ): Promise<{ version: number; results: unknown[] }> {
    const state = this.required("procedures", context.owner, id)
      .data as unknown as ProcedureState;
    if (state.status !== "verified")
      throw new Error("Only verified procedures can replay");
    return {
      version: state.version,
      results: await this.executeProcedure(context, state.definition, {
        kind: "procedure",
        id,
        version: state.version,
        phase: "step",
      }),
    };
  }
  private async executeProcedure(
    context: ToolContext,
    definition: Procedure,
    source: ToolSource,
  ): Promise<unknown[]> {
    await this.checkFiles(
      context,
      definition.preconditions,
      "Procedure precondition",
      { ...source, phase: "precondition" },
    );
    const results: unknown[] = [];
    for (const [index, step] of definition.steps.entries()) {
      const result = await executeTracedTool(
        this.registry,
        this.store,
        context,
        step.tool,
        step.args,
        { ...source, index },
      );
      results.push(result);
      if (!isDeepStrictEqual(result, step.expected)) {
        this.store.event(context.runId, "procedure.expectation_failed", {
          source: { ...source, index },
          expected: step.expected,
          actual: result,
        });
        throw new Error(
          `Procedure expected output mismatch for ${step.tool}; previous side effects were not undone`,
        );
      }
    }
    return results;
  }
  proposeSpecialist(context: ToolContext, input: unknown): SavedRecord {
    this.require(context, "specialists.manage");
    const definition = SpecialistSchema.parse(input),
      id = definition.id ?? randomUUID();
    if (definition.permissions.some((p) => !context.permissions.has(p)))
      throw new Error("Specialist permission escalation denied");
    const old = this.store.get("specialists", context.owner, id)
      ?.data as unknown as SpecialistState | undefined;
    const history = old
      ? [
          ...old.history,
          {
            version: old.version,
            definition: old.definition,
            evaluationPassed: old.evaluationPassed,
            ...(old.evidence ? { evidence: old.evidence } : {}),
          },
        ]
      : [];
    return this.store.save("specialists", context.owner, id, {
      version: (old?.version ?? 0) + 1,
      definition,
      evaluationPassed: false,
      activeVersion: old?.activeVersion ?? null,
      previousActive: old?.previousActive ?? null,
      history,
    });
  }
  async evaluateSpecialist(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    this.require(context, "specialists.manage");
    return this.runtime.auditOperation(
      context,
      "Evaluate specialist",
      (scoped) => this.evaluateCandidateSpecialist(scoped, id),
    );
  }
  private async evaluateCandidateSpecialist(
    context: ToolContext,
    id: string,
  ): Promise<SavedRecord> {
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    const run = await this.runtime.delegate(
      state.definition.evaluation.prompt,
      context,
      state.definition.permissions,
      state.definition.instructions,
    );
    let passed = run.status === "completed";
    try {
      await this.checkFiles(
        context,
        state.definition.evaluation.checks,
        "Specialist evaluation",
        {
          kind: "specialist",
          id,
          version: state.version,
          phase: "evaluation",
          childRunId: run.id,
        },
      );
    } catch {
      passed = false;
    }
    const current = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    if (
      current.version !== state.version ||
      !isDeepStrictEqual(current.definition, state.definition)
    )
      throw new Error("Specialist changed during evaluation");
    return this.store.save("specialists", context.owner, id, {
      ...current,
      evaluationPassed: passed,
      evidence: {
        runId: run.id,
        sourceRunId: context.runId,
        checkedAt: new Date().toISOString(),
      },
    });
  }
  promoteSpecialist(context: ToolContext, id: string): SavedRecord {
    this.require(context, "specialists.manage");
    const record = this.required("specialists", context.owner, id);
    const state = record.data as unknown as SpecialistState;
    if (!state.evaluationPassed || !state.evidence)
      throw new Error("A passing measured evaluation is required");
    if (state.activeVersion === state.version) return record;
    return this.store.save("specialists", context.owner, id, {
      ...state,
      previousActive: state.activeVersion,
      activeVersion: state.version,
    });
  }
  rollbackSpecialist(context: ToolContext, id: string): SavedRecord {
    this.require(context, "specialists.manage");
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    if (state.previousActive === null)
      throw new Error("No previous active specialist version");
    return this.store.save("specialists", context.owner, id, {
      ...state,
      activeVersion: state.previousActive,
      previousActive: state.activeVersion,
    });
  }
  /** The evaluated active version of a specialist, or an error the caller can show. */
  activeSpecialist(owner: string, id: string) {
    const state = this.required("specialists", owner, id).data as unknown as SpecialistState;
    const version = state.activeVersion === state.version ? state : state.history.find((v) => v.version === state.activeVersion);
    if (!version || !version.evaluationPassed) throw new Error(`Specialist ${id} has no evaluated active version`);
    return { permissions: version.definition.permissions, instructions: version.definition.instructions };
  }
  async delegate(context: ToolContext, id: string, prompt: string, options: { timeoutMs?: number; resultSchema?: Record<string, unknown> } = {}) {
    this.require(context, "specialists.use");
    const spec = this.activeSpecialist(context.owner, id);
    return this.runtime.delegateChecked(prompt, context, spec.permissions, spec.instructions, options);
  }
  async fanout(context: ToolContext, tasks: (FanoutTask & { specialist: string })[]) {
    this.require(context, "specialists.use");
    const specs = new Map(tasks.map((task) => [task.id, this.activeSpecialist(context.owner, task.specialist)]));
    return this.runtime.fanout(context, tasks, (id) => specs.get(id)!);
  }
  private async checkFiles(
    context: ToolContext,
    checks: z.infer<typeof CheckSchema>[],
    label: string,
    source: ToolSource,
  ): Promise<void> {
    for (const [index, check] of checks.entries()) {
      const result = (await executeTracedTool(
        this.registry,
        this.store,
        context,
        "files.verify",
        check,
        { ...source, index },
      )) as { verified: boolean };
      if (!result.verified) throw new Error(`${label} failed: ${check.path}`);
    }
  }
  private required(
    table: "procedures" | "specialists",
    owner: string,
    id: string,
  ): SavedRecord {
    const record = this.store.get(table, owner, id);
    if (!record) throw new Error(`${table} record not found`);
    return record;
  }
  private require(context: ToolContext, permission: string): void {
    context.signal.throwIfAborted();
    if (!context.permissions.has(permission))
      throw new Error(`Permission denied: ${permission}`);
  }
}

function registerProcedures(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registry.register({
    name: "procedures.propose",
    description:
      "Propose a versioned recipe with exact expected tool results and file preconditions.",
    permission: "procedures.manage",
    parameters: ProcedureSchema,
    execute: async (a, c) => knowledge.proposeProcedure(c, a),
  });
  registry.register({
    name: "procedures.verify",
    description:
      "Execute the proposed recipe and compare actual results. This performs its side effects.",
    permission: "procedures.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.verifyProcedure(c, a.id),
  });
  registry.register({
    name: "procedures.replay",
    description: "Execute a verified recipe after checking all preconditions.",
    permission: "procedures.use",
    parameters: idArgs,
    execute: async (a, c) => knowledge.replayProcedure(c, a.id),
  });
}
function registerSpecialists(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registry.register({
    name: "specialists.propose",
    description:
      "Create or revise a specialist with subset permissions and an explicit file evaluation.",
    permission: "specialists.manage",
    parameters: SpecialistSchema,
    execute: async (a, c) => knowledge.proposeSpecialist(c, a),
  });
  registry.register({
    name: "specialists.evaluate",
    description:
      "Run the candidate specialist and independently compare expected file contents.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.evaluateSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.promote",
    description: "Activate a candidate version only after passing evaluation.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.promoteSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.rollback",
    description: "Restore the previous active specialist version.",
    permission: "specialists.manage",
    parameters: idArgs,
    execute: async (a, c) => knowledge.rollbackSpecialist(c, a.id),
  });
  registry.register({
    name: "specialists.delegate",
    description:
      "Delegate to an evaluated active specialist with the same shared budget and reduced permissions. Optionally require the answer to match a JSON schema; a non-matching answer is reported as unresolved. Children stop after timeoutMs (default 120 s).",
    permission: "specialists.use",
    parameters: idArgs.extend({ prompt: z.string().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(120000).optional(), resultSchema: ResultSchemaSchema.optional() }),
    execute: async (a, c) => knowledge.delegate(c, a.id, a.prompt, { ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}), ...(a.resultSchema ? { resultSchema: a.resultSchema } : {}) }),
  });
  registry.register({
    name: "specialists.fanout",
    description:
      "Run several specialist tasks: independent tasks run at the same time, tasks with dependsOn wait for those results and receive them. Results are merged under this task.",
    permission: "specialists.use",
    parameters: z.object({ tasks: z.array(FanoutTaskSchema.extend({ specialist: z.string().min(1).max(200) })).min(1).max(8) }).strict(),
    execute: async (a, c) => knowledge.fanout(c, a.tasks),
  });
}
export function registerKnowledge(
  registry: ToolRegistry,
  knowledge: Knowledge,
): void {
  registerProcedures(registry, knowledge);
  registerSpecialists(registry, knowledge);
  registry.register({
    name: "knowledge.list",
    description:
      "List stored procedures and specialists for the current owner.",
    permission: "memory.read",
    parameters: z.object({}).strict(),
    execute: async (_a, c) => ({
      procedures: knowledge.store.list("procedures", c.owner),
      specialists: knowledge.store.list("specialists", c.owner),
    }),
  });
}
