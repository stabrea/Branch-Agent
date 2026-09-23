/**
 * packages.trajectories, the other half of the remaining gap. `src/trajectory.ts` now exports a
 * named batch of tasks that already exist, compressed for real (`gzipTrajectoryBatch`) — but every
 * one of those tasks still had to happen some other way first. Nothing generated a batch of
 * trajectories on demand. `runs.generate_batch` does: it runs a list of prompts as real new tasks,
 * one after another, and saves their trajectories into the workspace in the exact file shape the
 * batch export already uses, so a generated batch and an exported one are never two formats.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { chatOwnerOnly, runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { gzipTrajectoryBatch, receiptOutcomes, type TrajectoryOptions } from "./trajectory.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";

const GenerateBatchSchema = z.object({
  /** The prompts to run, one task each, in order. */
  prompts: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
  maxSteps: z.number().int().min(1).max(60).default(20),
  maxTokens: z.number().int().min(1000).max(400_000).default(80_000),
}).strict();

/**
 * What a generated task is allowed to do: everything this call itself was allowed, minus the one
 * permission that could start another batch (or any other delegation) from inside a generated
 * task. Without this, a generated task asking to run `runs.generate_batch` again would open a batch
 * inside a batch with no depth limit at all — `runtime.run` starts a fresh top-level task, not a
 * delegated child, so the ordinary delegation-depth check in `delegateChecked` never sees it.
 */
function withoutDelegation(permissions: ReadonlySet<string>): string[] {
  return [...permissions].filter((permission) => permission !== "specialists.use");
}

export const generateBatchKeyRefusal =
  "A short-lived key cannot start a batch of new tasks. Start the batch in the app window.";

/**
 * Who may start a batch. Every generated task is a fresh top-level task, so without this a
 * short-lived key's task (or a chat's) would start up to twenty tasks recorded as the owner's own
 * work. The record is read as well as the live mark: a key's task resumed after a restart carries
 * no live mark, only the `shortLivedKey` its `run.started` wrote down.
 */
function batchRefusal(store: Store, context: { runId: string; source?: string | undefined }): Error | null {
  if (startedWithShortLivedKey() || (context.runId && runOrigin(store, context.runId).shortLivedKey))
    return new Error(generateBatchKeyRefusal);
  if (startedFromChat(context, store)) return chatOwnerOnly("Starting a batch of new tasks");
  return null;
}

/**
 * `runs.generate_batch`: runs several prompts as real new tasks, one after another, and writes
 * their trajectories into the workspace as one gzip-compressed batch file. Cancelling the task
 * that asked for the batch cancels whichever prompt is still running.
 */
export function registerGenerateBatch(registry: ToolRegistry, store: Store, runtime: Runtime, version: string): void {
  registry.register({
    name: "runs.generate_batch",
    description: "Run several prompts as real new tasks, one after another, and save their trajectories into the workspace as one gzip-compressed batch file.",
    permission: "specialists.use",
    parameters: GenerateBatchSchema,
    execute: async (input, context) => {
      const refused = batchRefusal(store, context);
      if (refused) throw refused;
      const permissions = withoutDelegation(context.permissions);
      const runs: { runId: string; status: string }[] = [];
      for (const prompt of input.prompts) {
        const run = await runtime.run({
          prompt, permissions, signal: context.signal,
          budget: { maxSteps: input.maxSteps, maxTokens: input.maxTokens },
          ...(context.source ? { source: context.source } : {}),
          // Each generated task names the task that asked for it, so its origin (who started it,
          // a key's mark, a chat) is read along the record rather than taken as the owner's own.
          ...(context.runId ? { originFrom: context.runId } : {}),
          traceAttributes: { "branch.trajectory.batch": "runs.generate_batch" },
        });
        runs.push({ runId: run.id, status: run.status });
      }
      const optionsById = new Map<string, TrajectoryOptions>();
      for (const { runId } of runs)
        optionsById.set(runId, {
          receipts: await receiptOutcomes(store, runId),
          timeline: store.usageStore().getRunTimeline(runId), cost: null, version,
        });
      const gzip = gzipTrajectoryBatch(store, runs.map((r) => r.runId), (runId) => optionsById.get(runId)!, runtime.hideSecrets);
      const folder = join(context.workspace, "trajectories");
      await mkdir(folder, { recursive: true });
      const filename = `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.gz`;
      await writeFile(join(folder, filename), gzip);
      audit(store, context.owner, {
        action: "data.exported", actor: context.owner, subject: `a batch of ${runs.length} generated task(s)`,
        reason: "runs.generate_batch ran these prompts as new tasks and saved their trajectories",
        outcome: "saved", ...(context.runId ? { runId: context.runId } : {}),
      });
      return { count: runs.length, links: runs, bytes: gzip.byteLength, path: join("trajectories", filename) };
    },
  });
}
