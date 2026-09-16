import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * Short-lived keys for the things that are not the app window: the SDK, a browser extension, a
 * small script. The local session key lets its holder do everything for as long as Branch is
 * installed, which is the wrong thing to paste into a script. A key made here says what it is for
 * ("read" may only look; "run" may also start a task), stops working at a stated minute, and can be
 * taken back at any time. Only the hash is kept, so the key itself exists once, on the screen it
 * was printed on, and nowhere else.
 *
 * The master session key is never one of these and is never touched by this file. That is
 * deliberate: a mistake here must be able to lock out a script, and never the owner.
 */
export const tokenScopes = ["read", "run"] as const;
export type TokenScope = (typeof tokenScopes)[number];

export const scopeDescriptions: Record<TokenScope, string> = {
  read: "May look at things only. It cannot start a task or change a setting.",
  run: "May look at things and start a task, but cannot change what Branch is allowed to do.",
};

export const TokenRequestSchema = z.object({
  /** What the key is for, in the owner's own words, so a list of them means something later. */
  name: z.string().trim().min(1).max(80).default("A script"),
  scope: z.enum(tokenScopes).default("read"),
  /** How long it works for. A key with no end is not offered at all. */
  minutes: z.number().int().min(1).max(60 * 24 * 30).default(60),
}).strict();
export type TokenRequest = z.input<typeof TokenRequestSchema>;

export interface TokenEntry {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
}
/** A key exists in full exactly once: here, on the way back to whoever asked for it. */
export interface IssuedToken { entry: TokenEntry; token: string }

const prefix = "branch_";
const digest = (token: string): Buffer => createHash("sha256").update(token).digest();
const sameHash = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** What a request wants to do, so a "read" key can be told apart from one that starts work. */
export interface TokenUse { method: string; executes: boolean }

export class SessionTokens {
  constructor(private readonly db: DatabaseSync, private readonly store: Store) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_tokens(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      scope TEXT NOT NULL, hash BLOB NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, last_used_at TEXT, uses INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS session_tokens_owner ON session_tokens(owner, expires_at)`);
  }

  /** Makes one key. The text is handed back once and never stored; only its hash is kept. */
  create(owner: string, input: unknown = {}): IssuedToken {
    const value = TokenRequestSchema.parse(input ?? {});
    const token = prefix + randomBytes(24).toString("hex");
    const id = randomBytes(8).toString("hex"), now = new Date();
    const entry: TokenEntry = {
      id, name: value.name, scope: value.scope, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + value.minutes * 60_000).toISOString(),
      revokedAt: null, lastUsedAt: null, uses: 0,
    };
    this.db.prepare("INSERT INTO session_tokens(id,owner,name,scope,hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, owner, entry.name, entry.scope, digest(token), entry.createdAt, entry.expiresAt);
    audit(this.store, owner, {
      action: "token.issued", actor: owner, subject: `${entry.name} (${entry.scope}, ${value.minutes} minute(s))`,
      reason: "A short-lived key was made for something outside the app window", outcome: "issued",
    });
    return { entry, token };
  }

  /** Every key of this owner, newest first. The keys themselves are not in here and cannot be. */
  list(owner: string): TokenEntry[] {
    return this.db.prepare("SELECT * FROM session_tokens WHERE owner=? ORDER BY created_at DESC LIMIT 200")
      .all(owner).map(toEntry);
  }

  /** Takes a key back at once. Answers false when there was no such key of this owner's. */
  revoke(owner: string, id: string): boolean {
    const row = this.db.prepare("SELECT name FROM session_tokens WHERE id=? AND owner=? AND revoked_at IS NULL").get(id, owner);
    if (!row) return false;
    this.db.prepare("UPDATE session_tokens SET revoked_at=? WHERE id=? AND owner=?").run(new Date().toISOString(), id, owner);
    audit(this.store, owner, {
      action: "token.issued", actor: owner, subject: `${String(row.name)} (${id})`,
      reason: "A short-lived key was taken back", outcome: "revoked",
    });
    return true;
  }

  /** Forgets keys that stopped working a while ago, so the table cannot grow for ever. */
  prune(owner: string, keepDays = 30): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM session_tokens WHERE owner=? AND expires_at < ?").run(owner, cutoff).changes);
  }

  /**
   * Checks a key that is not the master one. Answers the plain reason it was refused, or null when
   * the request may go ahead. A key that works has its use counted, so the owner can see it working.
   */
  check(owner: string, supplied: string, use: TokenUse, now = new Date()): string | null {
    if (!supplied.startsWith(prefix)) return "Local session token required";
    const hash = digest(supplied);
    const rows = this.db.prepare("SELECT * FROM session_tokens WHERE owner=?").all(owner).map(toRow);
    const found = rows.find((row) => sameHash(row.hash, hash));
    if (!found) return "That key is not one of this computer's keys";
    const entry = toEntry(found.row);
    if (entry.revokedAt) return "That key was taken back. Make a new one with: branch token create";
    if (Date.parse(entry.expiresAt) <= now.getTime())
      return "That key has run out. Make a new one with: branch token create";
    const refusal = scopeRefusal(entry.scope, use);
    if (refusal) return refusal;
    this.db.prepare("UPDATE session_tokens SET uses=uses+1, last_used_at=? WHERE id=?").run(now.toISOString(), entry.id);
    return null;
  }
}

/** What each scope may not do, in one sentence the holder of the key can act on. */
export function scopeRefusal(scope: TokenScope, use: TokenUse): string | null {
  if (scope === "read" && use.method !== "GET")
    return 'That key may only look at things. Make one with --scope run to start a task.';
  if (scope === "run") return null;
  return use.executes ? "That key may only look at things, and this would make Branch do something." : null;
}

function toRow(row: Record<string, unknown>): { hash: Buffer; row: Record<string, unknown> } {
  return { hash: Buffer.from(row.hash as Uint8Array), row };
}
function toEntry(row: Record<string, unknown>): TokenEntry {
  return {
    id: String(row.id), name: String(row.name), scope: String(row.scope) as TokenScope,
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    uses: Number(row.uses ?? 0),
  };
}
