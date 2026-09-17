import { z } from "zod";
import type { Store } from "../store.js";
import type { StoredPasskey } from "./webauthn.js";

/**
 * Bucket 19: the passkeys each person registered, by profile. Only public keys are kept.
 */
export interface NamedPasskey extends StoredPasskey { name: string; createdAt: string; lastUsedAt: string | null }

const PasskeySchema = z.object({
  credentialId: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/),
  jwk: z.record(z.string(), z.unknown()),
  alg: z.union([z.literal(-7), z.literal(-257)]),
  signCount: z.number().int().min(0),
  name: z.string().max(80),
  createdAt: z.string().max(40),
  lastUsedAt: z.string().max(40).nullable(),
}).strict();
const key = "people-passkeys";
const maximumPerPerson = 10;

export class Passkeys {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private all(): Record<string, NamedPasskey[]> {
    const saved = z.record(z.string().uuid(), z.array(PasskeySchema).max(maximumPerPerson))
      .safeParse(this.store.get("settings", this.owner, key)?.data ?? {});
    return saved.success ? saved.data as unknown as Record<string, NamedPasskey[]> : {};
  }
  private write(all: Record<string, NamedPasskey[]>): void {
    this.store.save("settings", this.owner, key, all);
  }
  of(profileId: string): NamedPasskey[] {
    return this.all()[profileId] ?? [];
  }
  /** What a screen may show: never the key itself. */
  describe(profileId: string): { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] {
    return this.of(profileId).map((each) => ({ id: each.credentialId, name: each.name, createdAt: each.createdAt, lastUsedAt: each.lastUsedAt }));
  }
  add(profileId: string, passkey: StoredPasskey, name: string): void {
    const all = this.all();
    const everyone = Object.values(all).flat();
    if (everyone.some((each) => each.credentialId === passkey.credentialId)) throw new Error("That passkey is already registered");
    const mine = all[profileId] ?? [];
    if (mine.length >= maximumPerPerson) throw new Error(`At most ${maximumPerPerson} passkeys each`);
    all[profileId] = [...mine, { ...passkey, name: name.trim().slice(0, 80) || "A passkey", createdAt: new Date().toISOString(), lastUsedAt: null }];
    this.write(all);
  }
  used(profileId: string, credentialId: string, signCount: number): void {
    const all = this.all();
    all[profileId] = (all[profileId] ?? []).map((each) => each.credentialId === credentialId
      ? { ...each, signCount, lastUsedAt: new Date().toISOString() } : each);
    this.write(all);
  }
  remove(profileId: string, credentialId: string): boolean {
    const all = this.all(), mine = all[profileId] ?? [];
    const kept = mine.filter((each) => each.credentialId !== credentialId);
    if (kept.length === mine.length) return false;
    all[profileId] = kept;
    this.write(all);
    return true;
  }
  forget(profileId: string): void {
    const all = this.all();
    delete all[profileId];
    this.write(all);
  }
}
