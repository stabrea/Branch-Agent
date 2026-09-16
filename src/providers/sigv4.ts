import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Amazon's request signing, written out by hand with node:crypto so Branch needs no AWS library.
 * AWS keys are never sent: each request carries a signature worked out from the secret, which the
 * secret itself cannot be recovered from. The intermediate strings are returned as well, because
 * that is what a published Amazon test vector checks and what localises a mistake.
 */
export interface SigV4Input {
  method: string;
  /** The address, already built, with any path segments encoded once. */
  url: URL;
  /** Headers to sign. `host` is added from the address when it is missing. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Session token for temporary credentials, when there is one. */
  sessionToken?: string | undefined;
  /** The moment the request is made; tests pass a fixed one. */
  now: Date;
  /**
   * Whether path segments are encoded a second time for the signature. Amazon's rule is yes for
   * every service except S3; Branch only talks to Bedrock, so the default is yes.
   */
  doubleEncodePath?: boolean;
}
export interface SigV4Result {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  credentialScope: string;
  signingKey: Buffer;
  signature: string;
  authorization: string;
  amzDate: string;
}

/** Amazon's UriEncode: everything but the unreserved characters becomes %XX in upper case. */
export function uriEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(char) ? char : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

function canonicalUri(pathname: string, doubleEncode: boolean): string {
  if (!pathname || pathname === "/") return "/";
  if (!doubleEncode) return pathname;
  return pathname.split("/").map(uriEncode).join("/");
}
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) pairs.push([uriEncode(name), uriEncode(value)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}
/** Header names lower-cased and sorted, values trimmed and runs of spaces squeezed to one. */
function canonicalHeaders(headers: Record<string, string>): { text: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

/** The signing key Amazon derives from the secret: date, then region, then service, then a marker. */
export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
}

/** Signs one request. The returned headers are what to send; the strings are what to check. */
export function signRequest(input: SigV4Input): SigV4Result {
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.url.host, ...input.headers, "x-amz-date": amzDate };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  const payloadHash = sha256(input.body);
  const { text, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname, input.doubleEncodePath ?? true),
    canonicalQuery(input.url),
    text,
    signed,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const key = signingKey(input.secretAccessKey, date, input.region, input.service);
  const signature = hmac(key, stringToSign).toString("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signed}, Signature=${signature}`;
  return {
    headers: { ...headers, authorization },
    canonicalRequest, stringToSign, credentialScope, signingKey: key, signature, authorization, amzDate,
  };
}

/** Compares two signatures without leaking how much of them matched. */
export function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"), right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
