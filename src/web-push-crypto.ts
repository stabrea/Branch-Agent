/**
 * FQ-surfaces.mobile-push: Web Push, built from Node's own `crypto` rather than a new dependency.
 * Two standards, both implemented by hand and checked against their own published test vectors
 * (tests/web-push-crypto.test.mjs): RFC 8291 (message encryption, aes128gcm) and the VAPID scheme
 * (an ES256-signed JWT that tells the push service who is sending, so it can rate-limit fairly).
 *
 * Nothing here talks to a network; `sendWebPush` takes a `fetch`-shaped function so a test can point
 * it at a local server standing in for a real push service (Chrome's, Firefox's, …). Reaching a real
 * one is the part this file cannot prove — see FEATURE-QUEUE.md's note on FQ-surfaces.mobile-push.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(text: string): Buffer {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/** A P-256 keypair kept as base64url coordinates, the shape that survives a trip through JSON storage. */
export interface StoredEcKey { x: string; y: string; d: string }

/** A fresh P-256 keypair (VAPID's, or an ephemeral one for a single message). */
export function generateEcKeyPair(): { publicKeyRaw: Buffer; privateKeyRaw: Buffer } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKeyRaw = ecdh.getPublicKey();
  const privateScalar = ecdh.getPrivateKey();
  const privateKeyRaw = privateScalar.length === 32 ? privateScalar : Buffer.concat([Buffer.alloc(32 - privateScalar.length), privateScalar]);
  return { publicKeyRaw, privateKeyRaw };
}
export function ecKeyToStored(publicKeyRaw: Buffer, privateKeyRaw: Buffer): StoredEcKey {
  return { x: toBase64Url(publicKeyRaw.subarray(1, 33)), y: toBase64Url(publicKeyRaw.subarray(33, 65)), d: toBase64Url(privateKeyRaw) };
}
export function storedEcKeyToRaw(stored: StoredEcKey): { publicKeyRaw: Buffer; privateKeyRaw: Buffer } {
  const publicKeyRaw = Buffer.concat([Buffer.from([0x04]), fromBase64Url(stored.x), fromBase64Url(stored.y)]);
  return { publicKeyRaw, privateKeyRaw: fromBase64Url(stored.d) };
}
function nodePrivateKey(stored: StoredEcKey) {
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", x: stored.x, y: stored.y, d: stored.d }, format: "jwk" });
}
function nodePublicKey(stored: Pick<StoredEcKey, "x" | "y">) {
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: stored.x, y: stored.y }, format: "jwk" });
}

/**
 * VAPID (RFC 8292): a JWT that says which application server is sending, signed with the server's
 * own P-256 key so the push service can tell a real sender from a stranger. `subject` is never the
 * owner's own address — a neutral, non-routable one keeps their email out of Google's or Mozilla's
 * hands (see CLAUDE.md's privacy rule on not sending user data to an unrelated service).
 */
export function signVapidJwt(vapidKey: StoredEcKey, audience: string, subject = "mailto:push@branch-agent.invalid", ttlSeconds = 12 * 60 * 60, now = Date.now()): string {
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlSeconds, sub: subject })));
  const signingInput = `${header}.${claims}`;
  const signature = cryptoSign(null, Buffer.from(signingInput), { key: nodePrivateKey(vapidKey), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}
/** Only used by the crypto file's own test, to prove the JWT it signs actually verifies. */
export function verifyVapidJwt(jwt: string, vapidKey: Pick<StoredEcKey, "x" | "y">): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, claims, signature] = parts as [string, string, string];
  return cryptoVerify(null, Buffer.from(`${header}.${claims}`), { key: nodePublicKey(vapidKey), dsaEncoding: "ieee-p1363" }, fromBase64Url(signature));
}

const RECORD_SIZE = 4096;
const hmacSha256 = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
/** HKDF-Expand for the one-block case every step of RFC 8291's key schedule needs (length <= 32). */
const hkdfExpandOneBlock = (prk: Buffer, info: Buffer, length: number) => hmacSha256(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

export interface PushKeys {
  /** The subscription's `keys.p256dh`, decoded: the browser's own uncompressed P-256 public key. */
  p256dh: Buffer;
  /** The subscription's `keys.auth`, decoded: 16 bytes shared only between the browser and this server. */
  auth: Buffer;
}
/**
 * Encrypts a push message body per RFC 8291 (the "aes128gcm" content coding, RFC 8188). `salt` and
 * `sender` are only ever supplied by the test that reproduces RFC 8291 Appendix A's worked example
 * byte for byte; real sends always generate fresh ones.
 */
export function encryptWebPush(
  payload: Buffer,
  receiver: PushKeys,
  options: { salt?: Buffer; sender?: { publicKeyRaw: Buffer; privateKeyRaw: Buffer } } = {},
): { body: Buffer } {
  if (receiver.p256dh.length !== 65 || receiver.p256dh[0] !== 0x04) throw new Error("A push subscription's p256dh key must be an uncompressed P-256 point.");
  if (receiver.auth.length !== 16) throw new Error("A push subscription's auth secret must be 16 bytes.");
  const salt = options.salt ?? randomBytes(16);
  const sender = options.sender ?? generateEcKeyPair();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(sender.privateKeyRaw);
  const ecdhSecret = ecdh.computeSecret(receiver.p256dh);

  const prkKey = hmacSha256(receiver.auth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiver.p256dh, sender.publicKeyRaw]);
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpandOneBlock(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdfExpandOneBlock(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([sender.publicKeyRaw.length]), sender.publicKeyRaw]);
  const padded = Buffer.concat([payload, Buffer.from([0x02])]); // a single, "last" record (RFC 8188 §2)
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  return { body: Buffer.concat([header, ciphertext, cipher.getAuthTag()]) };
}

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: Buffer;
  /** Always "error": a push service answers where it is asked, and a redirect's target was never checked against the owner's network settings. */
  redirect: "error";
  signal?: AbortSignal;
}) => Promise<{ status: number; ok: boolean }>;

/**
 * Sends one already-composed message to one subscription. Returns the push service's response so
 * the caller can drop a subscription the service says is gone (404/410, RFC 8030 §7).
 */
export async function sendWebPush(
  fetchImpl: FetchLike,
  subscription: PushSubscription,
  vapidKey: StoredEcKey,
  payload: Buffer,
  options: { ttlSeconds?: number; subject?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; ok: boolean }> {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = signVapidJwt(vapidKey, audience, options.subject);
  const vapidPublicKeyRaw = storedEcKeyToRaw(vapidKey).publicKeyRaw;
  const { body } = encryptWebPush(payload, { p256dh: fromBase64Url(subscription.p256dh), auth: fromBase64Url(subscription.auth) });
  return fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttlSeconds ?? 300),
      authorization: `vapid t=${jwt}, k=${toBase64Url(vapidPublicKeyRaw)}`,
    },
    body,
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
