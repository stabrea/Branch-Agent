import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { currentPerson } from "./people/context.js"; // bucket 19

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
/** Wrong PINs in a row before a profile stops accepting them for a while. */
export const maximumPinAttempts = 5;
/** How long a profile waits after too many wrong PINs, in milliseconds. */
export const pinLockoutMs = 300000;
const hash = (pin: string, salt: string): Buffer => scryptSync(pin, salt, 32);

export class Profiles {
  /** The profile in use in this launch; null means the owner themselves. */
  private current: string | null = null;
  /** Wrong PINs counted per profile for this launch, so nobody can sit and try every number. */
  private readonly wrongPins = new Map<string, { count: number; until: number }>();
  /** Overridden in tests so the wait can be stepped over without sleeping. */
  now: () => number = () => Date.now();
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
    // bucket 19: a person signed in on their own device cannot switch the window's profile.
    if (currentPerson()) throw new Error("Switching who uses this computer is done at the computer itself.");
    const value = SwitchSchema.parse(input);
    if (value.profileId === null) { this.current = null; return { active: null, scope: this.owner }; }
    const row = this.db.prepare("SELECT * FROM household_profiles WHERE owner=? AND id=?").get(this.owner, value.profileId);
    if (!row) throw new Error("No profile with that name");
    const at = this.verifyPin(value.profileId, value.pin ?? "");
    this.current = value.profileId;
    return { active: { id: value.profileId, name: String(row.name), createdAt: String(row.created_at), lastUsedAt: at }, scope: this.scope() };
  }
  /**
   * bucket 19: checks one profile's PIN without switching the window, counting wrong ones exactly as
   * a switch does (the same lockout), and answers when it was last used. Throws on a wrong PIN.
   */
  verifyPin(profileId: string, pin: string): string {
    const row = this.db.prepare("SELECT * FROM household_profiles WHERE owner=? AND id=?").get(this.owner, profileId);
    if (!row) throw new Error("That PIN is not right");
    this.checkNotLockedOut(profileId);
    const supplied = hash(pin, String(row.salt));
    const stored = Buffer.from(row.pin_hash as Uint8Array);
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      this.countWrongPin(profileId);
      throw new Error("That PIN is not right");
    }
    this.wrongPins.delete(profileId);
    const at = new Date().toISOString();
    this.db.prepare("UPDATE household_profiles SET last_used_at=? WHERE id=?").run(at, profileId);
    return at;
  }
  /** bucket 19: a new PIN for one profile, after a reset the owner started or the person's own change. */
  setPin(profileId: string, pin: string): void {
    const value = ProfileSchema.shape.pin.parse(pin);
    const salt = randomBytes(16).toString("hex");
    const changed = this.db.prepare("UPDATE household_profiles SET salt=?, pin_hash=? WHERE owner=? AND id=?")
      .run(salt, hash(value, salt), this.owner, profileId).changes;
    if (!changed) throw new Error("No profile with that name");
    this.wrongPins.delete(profileId);
  }
  /** bucket 19: the profile a typed name belongs to, ignoring case; null when nobody here has it. */
  byName(name: string): Profile | null {
    const wanted = name.trim().toLowerCase();
    return this.list().find((profile) => profile.name.toLowerCase() === wanted) ?? null;
  }
  /** Refuses a switch while a profile is still waiting out its run of wrong PINs. */
  private checkNotLockedOut(profileId: string): void {
    const record = this.wrongPins.get(profileId);
    if (!record || record.count < maximumPinAttempts) return;
    if (this.now() < record.until)
      throw new Error("Too many wrong PINs. Wait a few minutes and try again.");
    this.wrongPins.delete(profileId);
  }
  private countWrongPin(profileId: string): void {
    const count = (this.wrongPins.get(profileId)?.count ?? 0) + 1;
    this.wrongPins.set(profileId, { count, until: this.now() + pinLockoutMs });
  }
  /** Who is using the app right now: a profile, or the owner. */
  active(): Profile | null {
    const id = this.who();
    if (!id) return null;
    const found = this.list().find((profile) => profile.id === id) ?? null;
    // bucket 19: a person's key whose profile was removed is nobody, and never falls back to the owner.
    if (!found && currentPerson()) throw new Error("That person is no longer on this computer.");
    return found;
  }
  /** bucket 19: a signed-in person's request answers for them; otherwise the window's switch does. */
  private who(): string | null {
    return currentPerson()?.profileId ?? this.current;
  }
  /** The name records are saved under for whoever is using the app: separate per profile. */
  scope(): string {
    const id = this.who();
    return id ? `profile:${id}` : this.owner;
  }
  /** The owner's own name, so a caller can tell the owner's records apart from a profile's. */
  get ownerName(): string {
    return this.owner;
  }
  isOwner(): boolean {
    return this.who() === null;
  }
  /** Refuses anything only the owner may reach: their secrets, their projects, their settings. */
  requireOwner(what = "This"): void {
    if (this.who() !== null)
      throw new Error(`${what} belongs to the owner. Switch back to the owner's profile to use it.`);
  }
}
