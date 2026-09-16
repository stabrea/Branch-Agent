import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Locking the app. The person can lock it from the header, and it locks itself after a chosen
 * quiet period. While it is locked Branch Agent keeps answering from what it already knows, but it
 * will not take a saved password or key out of the locker until the person unlocks it again.
 */
export const SessionLockSchema = z.object({
  /** Lock by itself after this many quiet minutes; 0 means never lock by itself. */
  idleMinutes: z.number().int().min(0).max(1440).default(0),
  /** Whether a locked app may still use saved passwords and keys. Off is the safe answer. */
  secretsWhileLocked: z.boolean().default(false),
}).strict();
export type SessionLockConfig = z.infer<typeof SessionLockSchema>;
export interface SessionLockState {
  locked: boolean; idleMinutes: number; idleSeconds: number;
  lockedSince: string | null; lastActiveAt: string;
}
const settingsKey = "session-lock";

export class SessionLock {
  private lastActive: number;
  private lockedAt: number | null = null;
  constructor(private readonly store: Store, private readonly owner: string, private readonly now: () => number = Date.now) {
    this.lastActive = this.now();
  }
  settings(): SessionLockConfig {
    const saved = SessionLockSchema.safeParse(this.store.get("settings", this.owner, settingsKey)?.data ?? {});
    return saved.success ? saved.data : SessionLockSchema.parse({});
  }
  configure(input: unknown): SessionLockConfig {
    const next = SessionLockSchema.parse(input ?? {});
    this.store.save("settings", this.owner, settingsKey, next);
    this.lastActive = this.now();
    return next;
  }
  /** Called whenever the owner does something in the app, so the quiet period starts again. */
  touch(): void {
    if (this.lockedAt === null) this.lastActive = this.now();
  }
  lock(): SessionLockState { this.lockedAt ??= this.now(); return this.state(); }
  /** The owner unlocking from their own app; the request already carries the app's session token. */
  unlock(): SessionLockState {
    this.lockedAt = null;
    this.lastActive = this.now();
    return this.state();
  }
  locked(): boolean {
    if (this.lockedAt !== null) return true;
    const { idleMinutes } = this.settings();
    if (idleMinutes > 0 && this.now() - this.lastActive >= idleMinutes * 60_000) this.lockedAt = this.now();
    return this.lockedAt !== null;
  }
  state(): SessionLockState {
    const locked = this.locked(), { idleMinutes } = this.settings();
    return { locked, idleMinutes, idleSeconds: Math.round((this.now() - this.lastActive) / 1000),
      lockedSince: this.lockedAt === null ? null : new Date(this.lockedAt).toISOString(),
      lastActiveAt: new Date(this.lastActive).toISOString() };
  }
  /** Refuses to hand out a saved password or key while the app is locked. */
  require(): void {
    if (this.locked() && !this.settings().secretsWhileLocked)
      throw new Error("Branch Agent is locked. Unlock it before it uses a saved password or key.");
  }
}
