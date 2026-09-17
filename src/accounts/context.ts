import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which conversation a model call belongs to. A connection only sees the request, so the runtime
 * marks each call with its conversation, and the account pools read it to honour the account the
 * owner chose for that conversation and to note which account answered.
 */
export interface AccountCall {
  owner: string;
  sessionId: string;
  runId: string;
  /** Writes a line on the task's record (never a key or a token). */
  note?: (kind: string, data: Record<string, unknown>) => void;
}
const calls = new AsyncLocalStorage<AccountCall>();

export function withAccountCall<T>(call: AccountCall, work: () => Promise<T>): Promise<T> {
  return calls.run(call, work);
}
export function currentAccountCall(): AccountCall | undefined {
  return calls.getStore();
}
