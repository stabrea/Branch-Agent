import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

/**
 * Bucket 19: passkeys (WebAuthn), checked with nothing but Node's own crypto.
 *
 * A passkey is a key pair the person's phone or computer keeps; Branch only ever sees the public
 * half. Registering one reads the public key out of the authenticator's answer; signing in checks a
 * signature over a fresh challenge. Attestation (proof of which make of authenticator it is) is not
 * asked for, because a household does not need it and asking would send the person's device make to
 * nobody in particular. Only ES256 and RS256 keys are accepted, which covers every current platform.
 */
export interface StoredPasskey {
  credentialId: string;
  jwk: JsonWebKey;
  alg: -7 | -257;
  signCount: number;
}

export interface ExpectedCeremony { challenge: string; origin: string; rpId: string }

const b64 = (text: string): Buffer => Buffer.from(text, "base64url");
const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/* ---------- a small CBOR reader: only what WebAuthn uses ---------- */

type Cbor = number | bigint | boolean | null | undefined | string | Buffer | Cbor[] | Map<Cbor, Cbor>;

class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  byte(): number {
    if (this.offset >= this.data.length) throw new Error("The passkey answer is cut short");
    return this.data[this.offset++]!;
  }
  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) throw new Error("The passkey answer is cut short");
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  length(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return this.take(2).readUInt16BE();
    if (info === 26) return this.take(4).readUInt32BE();
    if (info === 27) {
      const big = this.take(8).readBigUInt64BE();
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("A number in the passkey answer is too large");
      return Number(big);
    }
    throw new Error("The passkey answer uses a CBOR form this reader does not accept");
  }
}

function readItem(reader: Reader, depth: number): Cbor {
  if (depth > 16) throw new Error("The passkey answer is nested too deeply");
  const head = reader.byte(), major = head >> 5, info = head & 31;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    throw new Error("The passkey answer uses a CBOR form this reader does not accept");
  }
  const size = reader.length(info);
  if (major === 0) return size;
  if (major === 1) return -1 - size;
  if (major === 2) return Buffer.from(reader.take(size));
  if (major === 3) return reader.take(size).toString("utf8");
  if (size > 1000) throw new Error("The passkey answer is too large");
  if (major === 4) return Array.from({ length: size }, () => readItem(reader, depth + 1));
  if (major === 5) {
    const map = new Map<Cbor, Cbor>();
    for (let i = 0; i < size; i++) map.set(readItem(reader, depth + 1), readItem(reader, depth + 1));
    return map;
  }
  throw new Error("The passkey answer uses a CBOR form this reader does not accept");
}

/** Reads one CBOR item from the front of `data`, and how many bytes it used. */
export function decodeCbor(data: Buffer): { value: Cbor; used: number } {
  const reader = new Reader(data);
  return { value: readItem(reader, 0), used: reader.offset };
}

/* ---------- the authenticator's data ---------- */

interface AuthData { rpIdHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; publicKey?: Map<Cbor, Cbor> }

function parseAuthData(data: Buffer, expectCredential: boolean): AuthData {
  if (data.length < 37) throw new Error("The passkey answer is cut short");
  const parsed: AuthData = { rpIdHash: data.subarray(0, 32), flags: data[32]!, signCount: data.readUInt32BE(33) };
  if (!expectCredential) return parsed;
  if (!(parsed.flags & 0x40)) throw new Error("The passkey answer carries no key");
  const idLength = data.readUInt16BE(53);
  parsed.credentialId = data.subarray(55, 55 + idLength);
  const { value } = decodeCbor(data.subarray(55 + idLength));
  if (!(value instanceof Map)) throw new Error("The passkey's key is not readable");
  parsed.publicKey = value;
  return parsed;
}

/** A COSE key as a JWK Node can load; only ES256 on P-256 and RS256. */
export function coseToJwk(cose: Map<Cbor, Cbor>): { jwk: JsonWebKey; alg: -7 | -257 } {
  const kty = cose.get(1), alg = cose.get(3);
  const bytes = (label: number): string => {
    const found = cose.get(label);
    if (!Buffer.isBuffer(found)) throw new Error("The passkey's key is incomplete");
    return found.toString("base64url");
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, alg: -7 };
  if (kty === 3 && alg === -257) {
    // Integration review: a short RSA key can be broken; 2048 bits is the least any platform makes.
    if (Buffer.from(bytes(-1), "base64url").length < 256) throw new Error("That passkey's key is too short");
    return { jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, alg: -257 };
  }
  throw new Error("Only ES256 and RS256 passkeys are accepted");
}

function checkClientData(clientDataJSON: string, type: string, expected: ExpectedCeremony): Buffer {
  const raw = b64(clientDataJSON);
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(raw.toString("utf8")) as typeof data; } catch { throw new Error("The passkey answer is not readable"); }
  if (data.type !== type) throw new Error("The passkey answer is for a different step");
  if (typeof data.challenge !== "string" || !same(b64(data.challenge), b64(expected.challenge)))
    throw new Error("The passkey answer is for a different sign-in");
  if (data.origin !== expected.origin) throw new Error("The passkey answer came from a different page");
  if (data.crossOrigin === true) throw new Error("The passkey answer came from inside another page");
  return raw;
}

function checkRp(auth: AuthData, rpId: string): void {
  if (!same(auth.rpIdHash, sha256(rpId))) throw new Error("The passkey belongs to a different address");
  if (!(auth.flags & 0x01)) throw new Error("The passkey was used without anybody present");
  // Integration review: the device must also have checked it was its owner (fingerprint, face, PIN).
  if (!(auth.flags & 0x04)) throw new Error("The passkey was used without the device checking who you are");
}

/** A new passkey's answer to `navigator.credentials.create`, checked; its public key comes back. */
export function verifyRegistration(
  answer: { id: string; clientDataJSON: string; attestationObject: string }, expected: ExpectedCeremony,
): StoredPasskey {
  checkClientData(answer.clientDataJSON, "webauthn.create", expected);
  const { value } = decodeCbor(b64(answer.attestationObject));
  const authBytes = value instanceof Map ? value.get("authData") : undefined;
  if (!Buffer.isBuffer(authBytes)) throw new Error("The passkey answer is not readable");
  const auth = parseAuthData(authBytes, true);
  checkRp(auth, expected.rpId);
  if (!same(auth.credentialId!, b64(answer.id))) throw new Error("The passkey answer does not match itself");
  const { jwk, alg } = coseToJwk(auth.publicKey!);
  createPublicKey({ key: jwk, format: "jwk" });
  return { credentialId: answer.id, jwk, alg, signCount: auth.signCount };
}

/**
 * A sign-in answer to `navigator.credentials.get`, checked against the stored passkey. Answers the
 * new signature count to store. A count that did not go up means the passkey may have been copied.
 */
export function verifyAssertion(
  answer: { id: string; clientDataJSON: string; authenticatorData: string; signature: string },
  stored: StoredPasskey, expected: ExpectedCeremony,
): number {
  if (!same(b64(answer.id), b64(stored.credentialId))) throw new Error("That passkey is not this person's");
  const clientData = checkClientData(answer.clientDataJSON, "webauthn.get", expected);
  const authBytes = b64(answer.authenticatorData);
  const auth = parseAuthData(authBytes, false);
  checkRp(auth, expected.rpId);
  const signed = Buffer.concat([authBytes, sha256(clientData)]);
  const key = createPublicKey({ key: stored.jwk, format: "jwk" });
  if (!verify("sha256", signed, key, b64(answer.signature))) throw new Error("The passkey's signature is not right");
  if ((auth.signCount > 0 || stored.signCount > 0) && auth.signCount <= stored.signCount)
    throw new Error("This passkey may have been copied. Remove it and register it again.");
  return auth.signCount;
}
