import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";

/**
 * The cryptography Nostr needs, written with Node's own pieces only:
 *
 * - BIP-340 Schnorr signatures over secp256k1 (https://github.com/bips/bip-0340), in plain BigInt
 *   arithmetic, following the specification's pseudocode step by step and checked against its
 *   official test vectors. Node's crypto has no Schnorr, and no new dependency is allowed.
 * - NIP-04 direct-message encryption (https://github.com/nostr-protocol/nips/blob/master/04.md):
 *   an ECDH shared secret (Node's createECDH) used as an AES-256-CBC key.
 * - NIP-01 event ids and the bech32 `nsec` form of a private key (NIP-19).
 *
 * Nothing here is constant-time. The only secret it handles is the assistant's own key, used on
 * the owner's own computer, which is the same trade-off every pure-JavaScript Nostr client makes.
 */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };

interface Point { x: bigint; y: bigint }
/** A point in Jacobian form (x = X/Z², y = Y/Z³), so adding needs no division. Z = 0 is infinity. */
interface Jacobian { X: bigint; Y: bigint; Z: bigint }

const mod = (a: bigint, m = P): bigint => ((a % m) + m) % m;

function powMod(base: bigint, exponent: bigint, m = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}

function double(p: Jacobian): Jacobian {
  if (p.Z === 0n || p.Y === 0n) return { X: 0n, Y: 1n, Z: 0n };
  const yy = mod(p.Y * p.Y);
  const s = mod(4n * p.X * yy);
  const m = mod(3n * p.X * p.X);
  const x = mod(m * m - 2n * s);
  return { X: x, Y: mod(m * (s - x) - 8n * yy * yy), Z: mod(2n * p.Y * p.Z) };
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const pz2 = mod(p.Z * p.Z), qz2 = mod(q.Z * q.Z);
  const u1 = mod(p.X * qz2), u2 = mod(q.X * pz2);
  const s1 = mod(p.Y * qz2 * q.Z), s2 = mod(q.Y * pz2 * p.Z);
  if (u1 === u2) return s1 === s2 ? double(p) : { X: 0n, Y: 1n, Z: 0n };
  const h = mod(u2 - u1), r = mod(s2 - s1);
  const h2 = mod(h * h), h3 = mod(h2 * h);
  const x = mod(r * r - h3 - 2n * u1 * h2);
  return { X: x, Y: mod(r * (u1 * h2 - x) - s1 * h3), Z: mod(h * p.Z * q.Z) };
}

function multiply(k: bigint, point: Point): Point | null {
  let result: Jacobian = { X: 0n, Y: 1n, Z: 0n };
  let current: Jacobian = { X: point.x, Y: point.y, Z: 1n };
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) result = add(result, current);
    current = double(current);
  }
  return toAffine(result);
}

function toAffine(p: Jacobian): Point | null {
  if (p.Z === 0n) return null;
  const inverse = powMod(p.Z, P - 2n);
  const inverse2 = mod(inverse * inverse);
  return { x: mod(p.X * inverse2), y: mod(p.Y * inverse2 * inverse) };
}

function negate(point: Point): Point { return { x: point.x, y: mod(-point.y) }; }
function sum(a: Point | null, b: Point | null): Point | null {
  if (!a) return b;
  if (!b) return a;
  return toAffine(add({ X: a.x, Y: a.y, Z: 1n }, { X: b.x, Y: b.y, Z: 1n }));
}

const toInt = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
const toBytes = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
function taggedHash(tag: string, ...parts: Uint8Array[]): Buffer {
  const tagHash = sha256(Buffer.from(tag, "utf8"));
  return sha256(tagHash, tagHash, ...parts);
}

/** The point with this x coordinate and an even y, or null when there is none (BIP-340 lift_x). */
function liftX(x: bigint): Point | null {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = powMod(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) return null;
  return { x, y: y & 1n ? P - y : y };
}

/** The x-only public key (32 bytes) for a 32-byte secret key. */
export function publicKeyOf(secretKey: Uint8Array): Buffer {
  const d = toInt(secretKey);
  if (secretKey.length !== 32 || d === 0n || d >= N) throw new Error("The Nostr private key is not a valid key");
  return toBytes(multiply(d, G)!.x);
}

/** BIP-340 signing. `auxRand` is fresh randomness; the test vectors hand in fixed bytes. */
export function schnorrSign(message: Uint8Array, secretKey: Uint8Array, auxRand: Uint8Array = randomBytes(32)): Buffer {
  const d0 = toInt(secretKey);
  if (secretKey.length !== 32 || d0 === 0n || d0 >= N) throw new Error("The Nostr private key is not a valid key");
  if (auxRand.length !== 32) throw new Error("Signing needs 32 bytes of randomness");
  const pub = multiply(d0, G)!;
  const d = pub.y & 1n ? N - d0 : d0;
  const masked = Buffer.from(toBytes(d));
  const auxHash = taggedHash("BIP0340/aux", auxRand);
  for (let i = 0; i < 32; i++) masked[i] = masked[i]! ^ auxHash[i]!;
  const k0 = mod(toInt(taggedHash("BIP0340/nonce", masked, toBytes(pub.x), message)), N);
  if (k0 === 0n) throw new Error("Signing failed; try again");
  const r = multiply(k0, G)!;
  const k = r.y & 1n ? N - k0 : k0;
  const e = mod(toInt(taggedHash("BIP0340/challenge", toBytes(r.x), toBytes(pub.x), message)), N);
  const signature = Buffer.concat([toBytes(r.x), toBytes(mod(k + e * d, N))]);
  if (!schnorrVerify(signature, message, toBytes(pub.x))) throw new Error("Signing failed its own check");
  return signature;
}

/** BIP-340 verification. Any malformed input is simply "not valid". */
export function schnorrVerify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const pub = liftX(toInt(publicKey));
  if (!pub) return false;
  const r = toInt(signature.subarray(0, 32));
  const s = toInt(signature.subarray(32, 64));
  if (r >= P || s >= N) return false;
  const e = mod(toInt(taggedHash("BIP0340/challenge", signature.subarray(0, 32), publicKey, message)), N);
  const point = sum(multiply(s, G), e === 0n ? null : multiply(e, negate(pub)));
  return !!point && (point.y & 1n) === 0n && point.x === r;
}

/** A Nostr event as NIP-01 writes it. */
export interface NostrEvent {
  id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
}
/** The event id: the SHA-256 of the canonical array NIP-01 defines. */
export function eventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return sha256(Buffer.from(canonical, "utf8")).toString("hex");
}
/** True only when the id matches the content and the signature matches the id and author. */
export function verifyEvent(event: NostrEvent): boolean {
  if (!/^[0-9a-f]{64}$/.test(event.id) || !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig)) return false;
  if (eventId(event) !== event.id) return false;
  return schnorrVerify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"));
}
/** Fills in the author, id and signature of an event. */
export function signEvent(draft: Omit<NostrEvent, "id" | "sig" | "pubkey">, secretKey: Uint8Array): NostrEvent {
  const pubkey = publicKeyOf(secretKey).toString("hex");
  const id = eventId({ ...draft, pubkey });
  return { ...draft, pubkey, id, sig: schnorrSign(Buffer.from(id, "hex"), secretKey).toString("hex") };
}

/** NIP-04: the shared key is the x coordinate of the ECDH point, used directly as the AES key. */
function sharedKey(secretKey: Uint8Array, theirPublicKey: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(theirPublicKey)) throw new Error("That is not a Nostr public key");
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(secretKey));
  return ecdh.computeSecret(Buffer.concat([Buffer.from([2]), Buffer.from(theirPublicKey, "hex")]));
}
export function nip04Encrypt(secretKey: Uint8Array, theirPublicKey: string, text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", sharedKey(secretKey, theirPublicKey), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${body.toString("base64")}?iv=${iv.toString("base64")}`;
}
export function nip04Decrypt(secretKey: Uint8Array, theirPublicKey: string, content: string): string {
  const match = /^([A-Za-z0-9+/=]+)\?iv=([A-Za-z0-9+/=]+)$/.exec(content);
  if (!match) throw new Error("The message is not in the NIP-04 shape");
  const iv = Buffer.from(match[2]!, "base64");
  if (iv.length !== 16) throw new Error("The message is not in the NIP-04 shape");
  const decipher = createDecipheriv("aes-256-cbc", sharedKey(secretKey, theirPublicKey), iv);
  return Buffer.concat([decipher.update(Buffer.from(match[1]!, "base64")), decipher.final()]).toString("utf8");
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Checksum(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= generators[i]!;
  }
  return check;
}
/** Reads a private key written as 64 hex characters or as a NIP-19 `nsec1…` string. */
export function readPrivateKey(value: string): Buffer {
  const text = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  const lower = text.toLowerCase();
  if (!lower.startsWith("nsec1")) throw new Error("The Nostr private key must be 64 hex characters or start with nsec1");
  const data = [...lower.slice(5)].map((c) => BECH32.indexOf(c));
  const hrp = [..."nsec"].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data];
  if (data.some((v) => v < 0) || data.length < 7 || bech32Checksum(expanded) !== 1)
    throw new Error("The Nostr private key (nsec) is not written correctly");
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (bytes.length !== 32) throw new Error("The Nostr private key (nsec) is not written correctly");
  return Buffer.from(bytes);
}
