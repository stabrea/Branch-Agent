import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";

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
  evidence?: { runId: string; checkedAt: string };
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
    const record = this.required("procedures", context.owner, id),
      state = record.data as unknown as ProcedureState;
    await this.executeProcedure(context, state.definition);
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
    const state = this.required("procedures", context.owner, id)
      .data as unknown as ProcedureState;
    if (state.status !== "verified")
      throw new Error("Only verified procedures can replay");
    return {
      version: state.version,
      results: await this.executeProcedure(context, state.definition),
    };
  }
  private async executeProcedure(
    context: ToolContext,
    definition: Procedure,
  ): Promise<unknown[]> {
    await this.checkFiles(
      context,
      definition.preconditions,
      "Procedure precondition",
    );
    const results: unknown[] = [];
    for (const step of definition.steps) {
      const result = await this.registry.execute(step.tool, step.args, context);
      results.push(result);
      if (!isDeepStrictEqual(result, step.expected))
        throw new Error(
          `Procedure expected output mismatch for ${step.tool}; previous side effects were not undone`,
        );
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
      );
    } catch {
      passed = false;
    }
    if (
      this.required("specialists", context.owner, id).data.version !==
      state.version
    )
      throw new Error("Specialist changed during evaluation");
    return this.store.save("specialists", context.owner, id, {
      ...state,
      evaluationPassed: passed,
      evidence: { runId: run.id, checkedAt: new Date().toISOString() },
    });
  }
  promoteSpecialist(context: ToolContext, id: string): SavedRecord {
    this.require(context, "specialists.manage");
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    if (!state.evaluationPassed || !state.evidence)
      throw new Error("A passing measured evaluation is required");
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
  async delegate(
    context: ToolContext,
    id: string,
    prompt: string,
  ): Promise<Run> {
    this.require(context, "specialists.use");
    const state = this.required("specialists", context.owner, id)
      .data as unknown as SpecialistState;
    const version =
      state.activeVersion === state.version
        ? state
        : state.history.find((v) => v.version === state.activeVersion);
    if (!version || !version.evaluationPassed)
      throw new Error("Specialist has no evaluated active version");
    return this.runtime.delegate(
      prompt,
      context,
      version.definition.permissions,
      version.definition.instructions,
    );
  }
  private async checkFiles(
    context: ToolContext,
    checks: z.infer<typeof CheckSchema>[],
    label: string,
  ): Promise<void> {
    for (const check of checks) {
      const result = (await this.registry.execute(
        "files.verify",
        check,
        context,
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

export function registerMemory(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: "memory.put",
    description: "Save explicit memory with source attribution and timestamp.",
    permission: "memory.write",
    parameters: z
      .object({
        text: z.string().min(1).max(4000),
        source: z.string().min(1).max(500),
      })
      .strict(),
    execute: async (a, c) =>
      store.save("memory", c.owner, randomUUID(), {
        ...a,
        sourceRunId: c.runId,
      }),
  });
  registry.register({
    name: "memory.search",
    description: "Search this owner's stored memory by literal text.",
    permission: "memory.read",
    parameters: z.object({ query: z.string().max(200) }).strict(),
    execute: async (a, c) =>
      store
        .list("memory", c.owner)
        .filter((r) =>
          String(r.data.text).toLowerCase().includes(a.query.toLowerCase()),
        )
        .slice(0, 20),
  });
  registry.register({
    name: "memory.delete",
    description: "Delete an owner-scoped memory.",
    permission: "memory.write",
    parameters: idArgs,
    execute: async (a, c) => store.delete("memory", c.owner, a.id),
  });
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
      "Delegate to an evaluated active specialist with the same shared budget and reduced permissions.",
    permission: "specialists.use",
    parameters: idArgs.extend({ prompt: z.string().min(1).max(8000) }),
    execute: async (a, c) => knowledge.delegate(c, a.id, a.prompt),
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
