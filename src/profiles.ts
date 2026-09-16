import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Profiles for a household. Someone else who uses this computer can be given their own named
 * profile with a PIN: their conversations and what the assistant remembers for them are kept apart
 * from the owner's, and they cannot reach the owner's saved secrets or projects. This is separation
 * on one computer, not separate accounts: it does not sync anywhere, and anyone who can open the
 * files on this machine can still read everything. The PIN keeps profiles apart, it does not lock
 * the data away.
 */
export const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(40),
  pin: z.string().regex(/^\d{4,8}$/, "A PIN is four to eight digits"),
}).strict();
export const SwitchSchema = z.object({
  /** The profile to switch to, or null to go back to the owner. */
  profileId: z.string().uuid().nullable(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
}).strict();
export interface Profile { id: string; name: string; createdAt: string; lastUsedAt: string | null }
const maximumProfiles = 8;
const hash = (pin: string, salt: string): Buffer => scryptSync(pin, salt, 32);

export class Profiles {
  /** The profile in use in this launch; null means the owner themselves. */
  private current: string | null = null;
  constructor(private readonly db: DatabaseSync, private readonly owner: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS household_profiles(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      name TEXT NOT NULL, salt TEXT NOT NULL, pin_hash BLOB NOT NULL, created_at TEXT NOT NULL,
      last_used_at TEXT)`);
  }
  create(input: unknown): Profile {
    const value = ProfileSchema.parse(input);
    if (this.list().length >= maximumProfiles) throw new Error(`At most ${maximumProfiles} people can share this computer`);
    if (this.list().some((profile) => profile.name.toLowerCase() === value.name.toLowerCase()))
      throw new Error("Someone here already uses that name");
    const id = randomUUID(), salt = randomBytes(16).toString("hex"), createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO household_profiles VALUES(?,?,?,?,?,?,?)")
      .run(id, this.owner, value.name, salt, hash(value.pin, salt), createdAt, null);
    return { id, name: value.name, createdAt, lastUsedAt: null };
  }
  list(): Profile[] {
    return this.db.prepare("SELECT id,name,created_at,last_used_at FROM household_profiles WHERE owner=? ORDER BY name")
      .all(this.owner).map((row) => ({ id: String(row.id), name: String(row.name),
        createdAt: String(row.created_at), lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at) }));
  }
  remove(id: string): { removed: boolean } {
    if (this.current === id) this.current = null;
    return { removed: this.db.prepare("DELETE FROM household_profiles WHERE owner=? AND id=?").run(this.owner, id).changes > 0 };
  }
  /** Switches to a profile after checking its PIN, or back to the owner with no PIN needed. */
  switch(input: unknown): { active: Profile | null; scope: string } {
    const value = SwitchSchema.parse(input);
    if (value.profileId === null) { this.current = null; return { active: null, scope: this.owner }; }
    const row = this.db.prepare("SELECT * FROM household_profiles WHERE owner=? AND id=?").get(this.owner, value.profileId);
    if (!row) throw new Error("No profile with that name");
    const supplied = hash(value.pin ?? "", String(row.salt));
    const stored = Buffer.from(row.pin_hash as Uint8Array);
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) throw new Error("That PIN is not right");
    const at = new Date().toISOString();
    this.db.prepare("UPDATE household_profiles SET last_used_at=? WHERE id=?").run(at, value.profileId);
    this.current = value.profileId;
    return { active: { id: value.profileId, name: String(row.name), createdAt: String(row.created_at), lastUsedAt: at }, scope: this.scope() };
  }
  /** Who is using the app right now: a profile, or the owner. */
  active(): Profile | null {
    return this.current ? this.list().find((profile) => profile.id === this.current) ?? null : null;
  }
  /** The name records are saved under for whoever is using the app: separate per profile. */
  scope(): string {
    return this.current ? `profile:${this.current}` : this.owner;
  }
  isOwner(): boolean {
    return this.current === null;
  }
  /** Refuses anything only the owner may reach: their secrets, their projects, their settings. */
  requireOwner(what = "This"): void {
    if (this.current !== null)
      throw new Error(`${what} belongs to the owner. Switch back to the owner's profile to use it.`);
  }
}
