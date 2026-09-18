/**
 * R17-005 (T-05): which keys and accounts a Trunk uses.
 *
 * The rule, from Hermes Bot Mode (hermes-agent `bot-mode.md`, MIT): API keys are copied from the
 * owner by default, and a sign-in account (a ChatGPT, Claude or Grok login) is never copied.
 * mac7/lockdown-fix: a sign-in account is not used for a Trunk at all — its conversation, its room
 * seats and its routines answer through API keys only (src/accounts/trunk-guard.ts). A Trunk's turn
 * carries its own `keys`, so the key it uses is its pick wherever the turn runs; the choice is also
 * written to its Trunk Chat for the accounts screen. `createBranch` hands in the port (src/index.ts, the R17-A block):
 * `pools` reads src/accounts/settings.ts and `choose` is `saveSessionChoice`. The no-op port below is
 * what a Trunks service built without it (a test) uses: the Trunk then uses the owner's keys.
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
    if (found && !found.signIn) { choices[pool.id] = found.id; continue; }
    const signIn = pool.accounts.some((a) => a.signIn); // a connection holds one kind of account
    choices[pool.id] = null;
    // mac7/lockdown-fix: enforced where the model is called (src/accounts/trunk-guard.ts), so nothing
    // here stands in for a pick: a sign-in never answers for a Trunk, and without a pick or copied keys
    // the connection refuses the Trunk rather than using the owner's default.
    if (signIn) notes.push(`${pool.label}: a sign-in account is never used for a Trunk, so this connection does not answer for it.`);
    else if (!keys.copyFromOwner) notes.push(`${pool.label}: your keys are not copied, so pick a key for this Trunk; until you do, this connection does not answer for it.`);
  }
  return { choices, notes };
}
