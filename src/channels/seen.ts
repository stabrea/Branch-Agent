import { createHash } from "node:crypto";

/**
 * Chat services resend a message when an answer is slow: LINE, Meta and most of the outgoing-webhook
 * services all retry. Without this the assistant would answer the same question twice. Each channel
 * keeps a short list of what it has already taken in, so the second copy is recognised and dropped.
 *
 * What is remembered is the service's own message id together with a fingerprint of who wrote what,
 * so a resend (the same id and the same words) is caught while a second, genuinely different message
 * that happens to carry the same id is still answered. The list is small and forgets quickly, so
 * saying the same words again a few minutes later is answered as normal.
 */
const defaultWindowMs = 120000;
const maximumRemembered = 500;

export class SeenMessages {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = defaultWindowMs, private readonly now: () => number = Date.now) {}
  /** The fingerprint of one message: its id when the service gives one, and who said what. */
  static key(messageId: string, senderId: string, chatId: string, text: string): string {
    return `${messageId}|${createHash("sha256").update(`${senderId}\n${chatId}\n${text}`).digest("base64")}`;
  }
  /** True the first time this message is offered, false for a copy of one already taken in. */
  first(key: string): boolean {
    const now = this.now();
    for (const [remembered, expires] of this.seen) if (expires <= now) this.seen.delete(remembered);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.windowMs);
    if (this.seen.size > maximumRemembered) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}
