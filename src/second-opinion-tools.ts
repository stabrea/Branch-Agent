import { Budget, errorText } from "./contracts.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import { DebateSchema, runDebate, secondOpinionSettings, type DebateAsk, type DebateOutcome } from "./second-opinion.js";

/**
 * The debate, as an ordinary tool. Two connections answer the same question on their own, then
 * each reads the other. Nothing new runs: every turn is one short model call with no tools, on the
 * task's own record and against the task's own budget, and the whole thing is held inside two
 * bounds the owner sets — how many exchanges, and how much it may spend altogether.
 */
export async function debateTool(runtime: Runtime, context: ToolContext, input: unknown): Promise<DebateOutcome> {
  const asked = DebateSchema.parse(input);
  const settings = secondOpinionSettings(runtime.store, context.owner);
  const run = runtime.store.run(context.runId);
  if (!run) throw new Error("A debate needs a task to belong to");
  const unknown = asked.sides.filter((side) => !runtime.models.presets.has(side));
  if (unknown.length)
    throw new Error(`There is no connection called ${unknown.join(" or ")}. Pick two from your model connections.`);
  const ask: DebateAsk = async (side, question) => {
    const preset = runtime.models.presets.get(side)!;
    const budget = new Budget({ maxSteps: 2, maxTokens: Math.max(1, Math.ceil(settings.debateMaxTokens / 6)) });
    const scoped: ToolContext = { ...context, permissions: new Set(), budget,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(60000)]) };
    try {
      const said = await runtime.completeAside(run, scoped, preset, question);
      return { text: said, spent: budget.tokens };
    } catch (error) {
      // A side that cannot answer says so in its own turn; it never fails the whole debate, and
      // what it did spend before failing still counts towards the ceiling.
      return { text: `This side could not answer: ${errorText(error)}`, spent: budget.tokens };
    }
  };
  const outcome = await runDebate(ask, asked, { exchanges: settings.debateExchanges, maxTokens: settings.debateMaxTokens });
  context.budget.charge(outcome.spent);
  runtime.store.event(context.runId, "debate.finished", {
    sides: asked.sides, exchanges: outcome.exchanges, spent: outcome.spent, stoppedBecause: outcome.stoppedBecause,
  });
  return outcome;
}

export function registerSecondOpinion(registry: ToolRegistry, runtime: Runtime): void {
  registry.register({
    name: "delegate.debate",
    description: "Two model connections answer one question, read each other, and you get both sides.",
    permission: "specialists.use",
    parameters: DebateSchema,
    execute: async (args, context) => debateTool(runtime, context, args),
  });
}
