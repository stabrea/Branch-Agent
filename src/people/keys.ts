import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Bucket 19: the key a person gets once they have signed in on their own device.
 *
 * It is held to that person's profile and can never stand for the owner. Only its hash is kept; it
 * stops working at the minute written down, when the person signs out, when the owner takes it back,
 * when the person's PIN is reset, and when the profile is removed. It starts with its own prefix, so
 * the server can tell it from the computer's key and from a script's key before looking anything up.
 */
export const personKeyPrefix = "branch_person_";

export interface PersonKeyEntry {
  id: string; profileId: string; method: string; device: string;
  createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null;
}

const digest = (key: string): Buffer => createHash("sha256").update(key).digest();

export class PersonKeys {
  constructor(private readonly db: DatabaseSync, private readonly owner: string, public now: () => Date = () => new Date()) {
    db.exec(`CREATE TABLE IF NOT EXISTS person_keys(id TEXT PRIMARY KEY, owner TEXT NOT NULL, profile_id TEXT NOT NULL,
      hash BLOB NOT NULL, method TEXT NOT NULL, device TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, last_used_at TEXT);
      CREATE INDEX IF NOT EXISTS person_keys_profile ON person_keys(owner, profile_id)`);
  }

  /** Makes one key for a person. The text is handed back once; only its hash is kept. */
  issue(profileId: string, minutes: number, method: string, device: string): { key: string; entry: PersonKeyEntry } {
    const key = personKeyPrefix + randomBytes(32).toString("hex");
    const at = this.now();
    const entry: PersonKeyEntry = {
      id: randomBytes(8).toString("hex"), profileId, method: method.slice(0, 60), device: device.slice(0, 120),
      createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + minutes * 60_000).toISOString(),
      revokedAt: null, lastUsedAt: null,
    };
    this.db.prepare(`INSERT INTO person_keys(id,owner,profile_id,hash,method,device,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(entry.id, this.owner, profileId, digest(key), entry.method, entry.device, entry.createdAt, entry.expiresAt);
    return { key, entry };
  }

  /** The working key's entry, or the plain reason it does not work. Counts the use. */
  check(supplied: string): PersonKeyEntry | string {
    if (!supplied.startsWith(personKeyPrefix)) return "That is not a person's key";
    const wanted = digest(supplied);
    const row = this.db.prepare("SELECT * FROM person_keys WHERE owner=? AND hash=?").get(this.owner, wanted);
    if (!row) return "That sign-in is not known here. Sign in again.";
    const stored = Buffer.from(row.hash as Uint8Array);
    if (stored.length !== wanted.length || !timingSafeEqual(stored, wanted)) return "That sign-in is not known here. Sign in again.";
    const entry = toEntry(row);
    if (entry.revokedAt) return "You were signed out. Sign in again.";
    if (Date.parse(entry.expiresAt) <= this.now().getTime()) return "Your sign-in has run out. Sign in again.";
    this.db.prepare("UPDATE person_keys SET last_used_at=? WHERE id=?").run(this.now().toISOString(), entry.id);
    return entry;
  }

  /** Whether this is a working key, counting nothing (a refused route is not a wrong key). */
  working(supplied: string): boolean {
    if (!supplied.startsWith(personKeyPrefix)) return false;
    const row = this.db.prepare("SELECT expires_at, revoked_at FROM person_keys WHERE owner=? AND hash=?").get(this.owner, digest(supplied));
    return !!row && row.revoked_at === null && Date.parse(String(row.expires_at)) > this.now().getTime();
  }

  list(profileId?: string): PersonKeyEntry[] {
    const rows = profileId
      ? this.db.prepare("SELECT * FROM person_keys WHERE owner=? AND profile_id=? ORDER BY created_at DESC LIMIT 200").all(this.owner, profileId)
      : this.db.prepare("SELECT * FROM person_keys WHERE owner=? ORDER BY created_at DESC LIMIT 200").all(this.owner);
    return rows.map(toEntry);
  }

  /** Takes one key back. `profileId`, when given, must be the key's own (a person signing out). */
  revoke(id: string, profileId?: string): boolean {
    const sql = profileId
      ? "UPDATE person_keys SET revoked_at=? WHERE owner=? AND id=? AND profile_id=? AND revoked_at IS NULL"
      : "UPDATE person_keys SET revoked_at=? WHERE owner=? AND id=? AND revoked_at IS NULL";
    const args = profileId ? [this.now().toISOString(), this.owner, id, profileId] : [this.now().toISOString(), this.owner, id];
    return Number(this.db.prepare(sql).run(...args).changes) > 0;
  }

  /** Signs one person out everywhere (a PIN reset, a removed profile, the owner's say-so). */
  revokeAll(profileId: string): number {
    return Number(this.db.prepare("UPDATE person_keys SET revoked_at=? WHERE owner=? AND profile_id=? AND revoked_at IS NULL")
      .run(this.now().toISOString(), this.owner, profileId).changes);
  }

  /** Signs everybody out (the owner switched signing in from other devices off). */
  revokeEveryone(): number {
    return Number(this.db.prepare("UPDATE person_keys SET revoked_at=? WHERE owner=? AND revoked_at IS NULL")
      .run(this.now().toISOString(), this.owner).changes);
  }

  /** Forgets keys that stopped working more than a month ago. */
  prune(keepDays = 30): number {
    const cutoff = new Date(this.now().getTime() - keepDays * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM person_keys WHERE owner=? AND expires_at < ?").run(this.owner, cutoff).changes);
  }
}

function toEntry(row: Record<string, unknown>): PersonKeyEntry {
  return {
    id: String(row.id), profileId: String(row.profile_id), method: String(row.method), device: String(row.device),
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
  };
}
