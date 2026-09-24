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
  /**
   * mac7/lockdown-fix: set when the call is a Trunk's (its conversation, a room seat, a routine, or
   * work under them). A sign-in account never answers it, and a key is chosen by the Trunk's own pick.
   */
  trunk?: {
    keys: { copyFromOwner: boolean; accounts: Record<string, string> };
    /** FQ-routing.isolated-agents: which Trunk, so work it sets going (a workflow or flow step) remembers as it. */
    id?: string;
  };
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

/** mac7/lockdown-fix: what a Trunk's call is told when only a sign-in is left (see trunk-guard.ts). */
export const trunkSignInRefusal =
  "A Trunk never answers through a sign-in account, and there is no connection with an API key for it to use. Add a connection with an API key in Settings › Models.";

/**
 * Integration review (mac7/lockdown-fix): the last check, inside each connection that answers through
 * somebody's sign-in. A Trunk's work (its turns, the tools and side jobs they start, the workflows and
 * flows it sets going, a mixture's members, keep-alive pings) is marked, and a sign-in refuses it here
 * whichever way the call arrived.
 */
export function refuseSignInForTrunk(): void {
  if (calls.getStore()?.trunk) throw new Error(trunkSignInRefusal);
}
