import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bucket 19: a one-time code the owner hands a person who forgot their PIN, or who has not set up a
 * passkey yet. The owner reads it off their own screen and tells the person; it works once, for
 * thirty minutes, and closes after five wrong tries. Using it signs the person out everywhere and
 * gives them a short key that may only set a new PIN or register a passkey.
 */
interface Pending { hash: Buffer; expiresAt: number; tries: number }
export const resetCodeMs = 30 * 60_000;
const digest = (code: string): Buffer => createHash("sha256").update(code.trim().toUpperCase()).digest();

export class ResetCodes {
  private readonly pending = new Map<string, Pending>();
  now: () => number = () => Date.now();

  /** A fresh code for one profile, replacing any earlier one. The code itself is kept nowhere. */
  issue(profileId: string): { code: string; expiresAt: string } {
    const code = randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "X").toUpperCase().slice(0, 8);
    const expiresAt = this.now() + resetCodeMs;
    this.pending.set(profileId, { hash: digest(code), expiresAt, tries: 0 });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Uses the code up if it is right; throws otherwise. */
  redeem(profileId: string | null, code: string): void {
    const found = profileId ? this.pending.get(profileId) : undefined;
    const supplied = digest(String(code));
    if (!found || found.expiresAt <= this.now()) {
      if (profileId) this.pending.delete(profileId);
      throw new Error("That code is not right, or has run out. Ask the owner for a new one.");
    }
    if (!timingSafeEqual(found.hash, supplied)) {
      found.tries += 1;
      if (found.tries >= 5) this.pending.delete(profileId!);
      throw new Error("That code is not right, or has run out. Ask the owner for a new one.");
    }
    this.pending.delete(profileId!);
  }
}
