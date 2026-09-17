import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { z } from "zod";
import type { IdentityLink, OidcProvider } from "./settings.js";

/**
 * Bucket 19: signing a person in through an OpenID Connect identity service.
 *
 * The standard authorization-code flow with PKCE, a nonce and a state, and the ID token checked
 * here with Node's own crypto: the signature against the service's published keys, the issuer, the
 * audience, the expiry and the nonce. Every address is reached through the owner's network rules.
 * The answer is only "this is the person the owner linked to that profile", never a new profile.
 */
export interface OidcDiscovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const DiscoverySchema = z.object({
  issuer: z.string().url(), authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(), jwks_uri: z.string().url(),
}).passthrough();

export type GuardedFetch = typeof fetch;

export interface OidcStart { url: string; state: string; nonce: string; verifier: string }

export interface VerifiedIdentity { subject: string; email: string | null; emailVerified: boolean; name: string | null }

const httpsOnly = (value: string, what: string): string => {
  if (!value.startsWith("https://")) throw new Error(`The identity service's ${what} is not an https address`);
  return value;
};

async function getJson(fetcher: GuardedFetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`The identity service answered ${response.status}`);
  return response.json();
}

/** Reads the service's discovery document, and refuses one that names a different issuer. */
export async function discover(fetcher: GuardedFetch, provider: OidcProvider): Promise<OidcDiscovery> {
  const base = provider.issuer.replace(/\/+$/, "");
  const doc = DiscoverySchema.parse(await getJson(fetcher, `${base}/.well-known/openid-configuration`));
  if (doc.issuer.replace(/\/+$/, "") !== base) throw new Error("The identity service names a different issuer than the one set up");
  for (const [what, value] of [["sign-in page", doc.authorization_endpoint], ["token address", doc.token_endpoint], ["key list", doc.jwks_uri]] as const)
    httpsOnly(value, what);
  return doc;
}

/** The address to send the person to, with everything needed to check the answer later. */
export function authorizationUrl(provider: OidcProvider, doc: OidcDiscovery, redirectUri: string): OidcStart {
  const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(doc.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code", client_id: provider.clientId, redirect_uri: redirectUri,
    scope: provider.scopes.includes("openid") ? provider.scopes.join(" ") : ["openid", ...provider.scopes].join(" "),
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  })) url.searchParams.set(name, value);
  return { url: url.toString(), state, nonce, verifier };
}

/** Trades the code for tokens and answers the checked ID token's claims. */
export async function finishSignIn(
  fetcher: GuardedFetch, provider: OidcProvider, doc: OidcDiscovery,
  input: { code: string; redirectUri: string; verifier: string; nonce: string; clientSecret?: string },
  now = Date.now(),
): Promise<VerifiedIdentity> {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri,
    client_id: provider.clientId, code_verifier: input.verifier,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  });
  const response = await fetcher(doc.token_endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form,
  });
  if (!response.ok) throw new Error(`The identity service refused the sign-in (${response.status})`);
  const tokens = z.object({ id_token: z.string().min(10).max(20000) }).passthrough().parse(await response.json());
  const keys = z.object({ keys: z.array(z.record(z.string(), z.unknown())).max(50) }).parse(await getJson(fetcher, doc.jwks_uri));
  return verifyIdToken(tokens.id_token, keys.keys as JsonWebKey[], { issuer: doc.issuer, clientId: provider.clientId, nonce: input.nonce }, now);
}

const ClaimsSchema = z.object({
  iss: z.string(), sub: z.string().min(1).max(255), aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(), iat: z.number(), nonce: z.string().optional(), azp: z.string().optional(),
  email: z.string().optional(), email_verified: z.union([z.boolean(), z.string()]).optional(), name: z.string().optional(),
}).passthrough();

/** Checks an ID token's signature and claims. Only RS256 and ES256 are accepted; "none" never is. */
export function verifyIdToken(
  token: string, jwks: JsonWebKey[], expected: { issuer: string; clientId: string; nonce: string }, now = Date.now(),
): VerifiedIdentity {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("The identity service's answer is not a signed token");
  const header = z.object({ alg: z.enum(["RS256", "ES256"]), kid: z.string().optional() }).passthrough()
    .parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
  const candidates = jwks.filter((key) => (!header.kid || (key as { kid?: string }).kid === header.kid)
    && key.kty === (header.alg === "RS256" ? "RSA" : "EC"));
  if (!candidates.length) throw new Error("The identity service did not publish the key its answer was signed with");
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2]!, "base64url");
  const good = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verify("sha256", signed, header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, signature);
    } catch { return false; }
  });
  if (!good) throw new Error("The identity service's answer is not signed by it");
  const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  checkClaims(claims, expected, now);
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return { subject: claims.sub, email: claims.email?.toLowerCase() ?? null, emailVerified: verified, name: claims.name ?? null };
}

function checkClaims(claims: z.infer<typeof ClaimsSchema>, expected: { issuer: string; clientId: string; nonce: string }, now: number): void {
  const skew = 120;
  if (claims.iss.replace(/\/+$/, "") !== expected.issuer.replace(/\/+$/, "")) throw new Error("The answer came from a different identity service");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) throw new Error("The answer was meant for a different app");
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expected.clientId)
    throw new Error("The answer was meant for a different app");
  if (claims.exp + skew < now / 1000) throw new Error("The answer has run out. Sign in again.");
  if (claims.iat - skew > now / 1000) throw new Error("The answer is dated in the future");
  if (claims.nonce !== expected.nonce) throw new Error("The answer is for a different sign-in");
}

/**
 * Whether a checked identity is one the owner linked to this profile. Integration review: only the
 * service's own subject id signs somebody in. An email address can be changed at some services, so
 * a link that names only an email is a suggestion the owner confirms once (see `emailSuggests`).
 */
export function linkedTo(links: IdentityLink[], provider: string, profileId: string, identity: VerifiedIdentity): boolean {
  return links.some((link) => link.provider === provider && link.profileId === profileId && !!link.subject && link.subject === identity.subject);
}

/** Whether a verified email matches a link the owner made without a subject yet. */
export function emailSuggests(links: IdentityLink[], provider: string, profileId: string, identity: VerifiedIdentity): boolean {
  return identity.emailVerified && !!identity.email && links.some((link) => link.provider === provider
    && link.profileId === profileId && !link.subject && !!link.email && link.email.toLowerCase() === identity.email);
}
