import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * mac7/r17-g (R17-063): one-time codes from an authenticator app, as RFC 6238 describes them
 * (HMAC-SHA1, six digits, thirty-second steps), built on Node's own crypto. Written here from the
 * RFC; ZeroClaw's `security/otp.rs` (MIT or Apache-2.0) was read for the idea of refusing a code
 * that was already used.
 */
export const totpStepSeconds = 30;
export const totpDigits = 6;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("That is not a valid authenticator key");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte key, written the way authenticator apps read it. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The HOTP value (RFC 4226) for one counter. */
export function hotp(secret: Buffer, counter: number, digits = totpDigits): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
}

export const totpCounter = (unixSeconds: number, step = totpStepSeconds): number => Math.floor(unixSeconds / step);

export function totp(secretBase32: string, unixSeconds = Date.now() / 1000, step = totpStepSeconds, digits = totpDigits): string {
  return hotp(base32Decode(secretBase32), totpCounter(unixSeconds, step), digits);
}

/**
 * The counter a code matches, within one step either side for a slow clock, or null. Codes are
 * compared in constant time.
 */
export function matchTotp(secretBase32: string, code: string, unixSeconds = Date.now() / 1000, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32), now = totpCounter(unixSeconds);
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(secret, now + drift));
    if (timingSafeEqual(expected, Buffer.from(code))) return now + drift;
  }
  return null;
}

/** The address an authenticator app reads from a QR code or a pasted link. */
export function otpauthUri(secretBase32: string, account: string, issuer = "Branch Agent"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${totpDigits}&period=${totpStepSeconds}`;
}
