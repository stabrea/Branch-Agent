/**
 * R17-005 (T-05): which keys and accounts a Trunk uses.
 *
 * The rule, from Hermes Bot Mode (hermes-agent `bot-mode.md`, MIT): API keys are copied from the
 * owner by default, and a sign-in account (a ChatGPT, Claude or Grok login) is never copied — the
 * owner picks one for the Trunk or it has none.
 *
 * Several accounts per connection are being built on `mac6/accounts` (src/accounts/). There, the
 * account a model call uses is the conversation's own choice (`saveSessionChoice` in
 * src/accounts/settings.ts), and a Trunk always talks in its own conversation, so a Trunk's account
 * is simply its Trunk Chat's choice. This file is the seam: `createBranch` hands in a port once the
 * accounts work is merged; until then the no-op port keeps the choice on the Trunk and says so.
 *
 * HOOK (mac6/accounts): wire `TrunkAccountsPort` to src/accounts/settings.ts when it lands:
 *   choose: (sessionId, pool, account) => saveSessionChoice(store, owner, sessionId, pool, account)
 *   pools:  () => the connections with several accounts, each with its accounts and whether it is a sign-in
 */
export interface TrunkAccountChoice { id: string; label: string; signIn: boolean }
export interface TrunkAccountPool { id: string; label: string; accounts: TrunkAccountChoice[] }

export interface TrunkAccountsPort {
  /** True once the accounts work is connected. */
  readonly connected: boolean;
  pools(): TrunkAccountPool[];
  /** Makes `account` the one a conversation uses for `pool`; null goes back to the owner's default. */
  choose(sessionId: string, pool: string, account: string | null): void;
}

export const noAccounts: TrunkAccountsPort = {
  connected: false,
  pools: () => [],
  choose: () => undefined,
};

export interface KeyPlan {
  /** Each connection's account for this Trunk, or null for the owner's default key. */
  choices: Record<string, string | null>;
  /** Plain sentences about anything the Trunk cannot use yet. */
  notes: string[];
}

/**
 * What a Trunk's key settings come to. With "copy from owner" on, every connection without a pick
 * uses the owner's keys, except sign-in accounts, which are never copied. With it off, only what
 * the owner picked is used.
 */
export function keyPlan(keys: { copyFromOwner: boolean; accounts: Record<string, string> }, pools: TrunkAccountPool[]): KeyPlan {
  const choices: Record<string, string | null> = {};
  const notes: string[] = [];
  for (const pool of pools) {
    const picked = keys.accounts[pool.id];
    const found = picked ? pool.accounts.find((a) => a.id === picked) : undefined;
    if (found) { choices[pool.id] = found.id; continue; }
    const signInOnly = pool.accounts.length > 0 && pool.accounts.every((a) => a.signIn);
    if (!keys.copyFromOwner || signInOnly) {
      choices[pool.id] = null;
      notes.push(`${pool.label}: pick an account for this Trunk; ${signInOnly ? "a sign-in is never copied from you" : "your keys are not copied"}.`);
    } else choices[pool.id] = null;
  }
  return { choices, notes };
}
