// Types for the React hooks. The client itself is typed in packages/sdk/types.d.ts.
import type { BranchClient, RunInput } from "@branch-agent/sdk";

export interface RunEvent { kind: string; [field: string]: unknown }

export interface RunState {
  runId: string | null;
  /** "idle", "starting", "running", then the task's own status ("completed", "failed", ...) or "cancelled". */
  status: string;
  events: readonly RunEvent[];
  output: string;
  error: unknown;
}

export interface RunStore {
  subscribe(listener: () => void): () => void;
  snapshot(): RunState;
  start(prompt: string, input?: Omit<RunInput, "prompt">): Promise<unknown>;
  steer(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  detach(): void;
}

export interface GetState<T> { data: T | null; error: unknown; loading: boolean; refresh(): void }

export interface BranchHooks {
  BranchContext: unknown;
  BranchProvider(props: { client: BranchClient; children?: unknown }): unknown;
  useBranch(): BranchClient;
  /** Pass `null` as the path to read nothing yet. */
  useBranchGet<T = unknown>(path: string | null, options?: { everyMs?: number }): GetState<T>;
  useBranchRun(): RunState & Pick<RunStore, "start" | "steer" | "cancel">;
}

export declare function createRunStore(client: BranchClient): RunStore;
export declare function createBranchHooks(react: unknown): BranchHooks;
export declare const BranchContext: BranchHooks["BranchContext"];
export declare const BranchProvider: BranchHooks["BranchProvider"];
export declare const useBranch: BranchHooks["useBranch"];
export declare const useBranchGet: BranchHooks["useBranchGet"];
export declare const useBranchRun: BranchHooks["useBranchRun"];
