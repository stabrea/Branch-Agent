import { randomUUID } from "node:crypto";
import { errorText } from "./contracts.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

export interface ToolSource {
  kind: "procedure" | "specialist";
  id: string;
  version: number;
  phase: "precondition" | "step" | "evaluation";
  index?: number;
  childRunId?: string;
}

export async function executeTracedTool(
  registry: ToolRegistry,
  store: Store,
  context: ToolContext,
  name: string,
  args: unknown,
  source: ToolSource,
): Promise<unknown> {
  const trace = { id: randomUUID(), name, source, sourceRunId: context.runId };
  store.event(context.runId, "tool.started", { ...trace, args });
  try {
    const result = await registry.execute(name, args, context);
    store.event(context.runId, "tool.completed", { ...trace, result });
    return result;
  } catch (error) {
    store.event(context.runId, "tool.failed", {
      ...trace,
      error: errorText(error),
      outcome: "unknown",
      interrupted: context.signal.aborted,
    });
    throw error;
  }
}
