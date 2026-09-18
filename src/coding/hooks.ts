import type { Message, Run, ToolContext } from "../contracts.js";
import type { TaskPlace } from "./worktrees.js";

/**
 * mac7/r17-d: the two places the runtime asks the coding parts something (src/runtime.ts, marked
 * blocks). Kept as a type of its own so the runtime imports no coding code.
 */
export interface RoundNotes {
  /** Added to the working conversation once, before the first answer (what @ mentions point at). */
  once?: Message;
  /** Sent with this round only and never stored, so it survives compaction (checklist, folder rules). */
  every?: Message;
}
export interface CodingHooks {
  placeTask(run: Pick<Run, "id" | "sessionId">, context: ToolContext, parent: ToolContext | undefined): Promise<TaskPlace | null>;
  inPlace<T>(scope: string, work: () => Promise<T>): Promise<T>;
  roundNotes(run: Pick<Run, "id" | "sessionId" | "prompt">, context: ToolContext, round: number): Promise<RoundNotes>;
}
