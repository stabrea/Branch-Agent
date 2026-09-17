import type { DatabaseSync } from "node:sqlite";

/**
 * How much each account has been used this month: calls, tokens and the estimated cost, so a key
 * can have a monthly cap. Kept in its own table; no key or token is ever written here, only the
 * account's short id.
 */
export interface AccountUsage { requests: number; input: number; output: number; costUsd: number; lastUsedAt: string | null }
const empty = (): AccountUsage => ({ requests: 0, input: 0, output: 0, costUsd: 0, lastUsedAt: null });

export const monthOf = (when: Date): string => when.toISOString().slice(0, 7);

export class AccountUsageLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_usage(owner TEXT NOT NULL, pool TEXT NOT NULL, account TEXT NOT NULL,
      month TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, last_used_at TEXT,
      PRIMARY KEY(owner,pool,account,month))`);
  }
  record(owner: string, pool: string, account: string, used: { input: number; output: number; costUsd: number }, when = new Date()): void {
    this.db.prepare(`INSERT INTO account_usage VALUES(?,?,?,?,1,?,?,?,?) ON CONFLICT(owner,pool,account,month)
      DO UPDATE SET requests=requests+1, input=input+excluded.input, output=output+excluded.output,
      cost=cost+excluded.cost, last_used_at=excluded.last_used_at`)
      .run(owner, pool, account, monthOf(when), used.input, used.output, used.costUsd, when.toISOString());
  }
  month(owner: string, pool: string, account: string, when = new Date()): AccountUsage {
    const row = this.db.prepare("SELECT requests,input,output,cost,last_used_at FROM account_usage WHERE owner=? AND pool=? AND account=? AND month=?")
      .get(owner, pool, account, monthOf(when));
    if (!row) return empty();
    return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output),
      costUsd: Math.round(Number(row.cost) * 1_000_000) / 1_000_000, lastUsedAt: row.last_used_at ? String(row.last_used_at) : null };
  }
  forget(owner: string, pool: string, account: string): void {
    this.db.prepare("DELETE FROM account_usage WHERE owner=? AND pool=? AND account=?").run(owner, pool, account);
  }
}
