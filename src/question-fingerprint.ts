import { createHmac, randomBytes } from "node:crypto";

/**
 * The fingerprint every approval question carries, and that a yes is bound to: the tool the question is about and the
 * exact bytes it asks for, as a keyed digest. The key is made once when Branch starts and is never kept anywhere else,
 * so nobody outside the engine can work out the fingerprint of a request they were not shown, and the same bytes sent
 * to two different tools are two different questions.
 *
 * A fingerprint is only good for the launch that made it. Anything kept for longer (a server's saved launch, say) keeps
 * its own digest of its own bytes, never this one.
 */
const key = randomBytes(32);

/** The fingerprint of `argumentBytes` asked of `tool`: 32 hex characters. */
export function argumentFingerprint(tool: string, argumentBytes: string): string {
  return createHmac("sha256", key).update(`${tool}\u0000${argumentBytes}`, "utf8").digest("hex").slice(0, 32);
}
