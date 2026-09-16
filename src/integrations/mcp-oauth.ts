/**
 * Signing in to somebody else's MCP server.
 *
 * Some MCP servers do not hand out keys by hand: they publish where their sign-in lives, let a
 * program ask for its own client identity on the spot, and then run the ordinary sign-in in the
 * person's browser. Branch follows that: it reads the server's published sign-in details, registers
 * itself once and remembers the identity, and then hands the rest to the same sign-in machinery
 * every other connected service uses — so the key lands in the locker and never appears in a log,
 * an event or a message.
 *
 * Branch is only ever the one signing in here. It does not hand out keys of its own: another AI
 * tool connecting *to* Branch uses the session key the app already shows in Settings.
 */
import { z } from "zod";
import type { NetworkPolicy } from "../network-policy.js";
import type { OAuthConnections, OAuthProvider, OAuthStart } from "../oauth.js";
import type { Store } from "../store.js";

/** Where a server publishes how to sign in to it (RFC 8414). */
const discoveryPaths = ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"] as const;

const MetadataSchema = z.object({
  issuer: z.string().max(500).optional(),
  authorization_endpoint: z.string().min(1).max(500),
  token_endpoint: z.string().min(1).max(500),
  /** Present when the server lets a program ask for its own identity (RFC 7591). */
  registration_endpoint: z.string().min(1).max(500).optional(),
  scopes_supported: z.array(z.string().max(120)).max(100).optional(),
  code_challenge_methods_supported: z.array(z.string().max(40)).max(10).optional(),
}).loose();
export type McpAuthMetadata = z.infer<typeof MetadataSchema>;

const RegistrationSchema = z.object({
  client_id: z.string().min(1).max(300),
  client_secret: z.string().max(500).optional(),
}).loose();

const settingsKey = (id: string): string => `mcp-oauth:${id}`;

/** Reads the server's published sign-in details. Every address goes through the network policy. */
export async function discover(
  serverUrl: string, policy: NetworkPolicy, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<McpAuthMetadata> {
  const base = new URL(serverUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
    throw new Error("A server that needs a sign-in has to be reached over https.");
  const problems: string[] = [];
  for (const path of discoveryPaths) {
    const target = new URL(path, base.origin);
    await policy.assertAllowed(target, "sign-in details");
    try {
      const response = await fetchImpl(target, {
        redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { problems.push(`${path} answered ${response.status}`); continue; }
      const parsed = MetadataSchema.safeParse(await response.json());
      if (parsed.success) return parsed.data;
      problems.push(`${path} did not describe a sign-in`);
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message.slice(0, 80) : "no answer"}`);
    }
  }
  throw new Error(`That server does not publish how to sign in to it (${problems.join("; ")}).`);
}

/**
 * Asks the server for an identity of our own, the way a program with no pre-arranged key has to
 * (RFC 7591). The identity is kept so the next sign-in reuses it instead of registering again.
 */
export async function register(
  store: Store, owner: string, id: string, metadata: McpAuthMetadata, redirectUri: string,
  policy: NetworkPolicy, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const saved = store.get("settings", owner, settingsKey(id))?.data as { clientId?: string; clientSecret?: string } | undefined;
  if (saved?.clientId) return saved.clientSecret ? { clientId: saved.clientId, clientSecret: saved.clientSecret } : { clientId: saved.clientId };
  if (!metadata.registration_endpoint)
    throw new Error("That server needs a sign-in but does not let programs register themselves. Ask whoever runs it for a client id.");
  const target = new URL(metadata.registration_endpoint);
  await policy.assertAllowed(target, "sign-in registration");
  const response = await fetchImpl(target, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      client_name: "Branch Agent", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native",
    }),
  });
  if (!response.ok) throw new Error(`The server refused to register Branch (${response.status}).`);
  const registered = RegistrationSchema.parse(await response.json());
  const record = registered.client_secret
    ? { clientId: registered.client_id, clientSecret: registered.client_secret }
    : { clientId: registered.client_id };
  store.save("settings", owner, settingsKey(id), record);
  return record;
}

export const McpSignInSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  url: z.string().url(),
  scopes: z.array(z.string().min(1).max(120)).max(40).default([]),
}).strict();

/**
 * Starts the sign-in for one MCP server: reads its details, registers if it has to, then hands the
 * rest to the shared sign-in machinery, which does the proof-key dance and puts the key in the
 * locker. The returned address is the one to open in the person's own browser.
 */
export async function signIn(
  input: unknown, deps: {
    store: Store; owner: string; connections: OAuthConnections; policy: NetworkPolicy;
    fetchImpl?: typeof fetch;
  },
): Promise<OAuthStart & { registered: string }> {
  const parsed = McpSignInSchema.parse(input);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const metadata = await discover(parsed.url, deps.policy, fetchImpl);
  // The sign-in machinery picks a free loopback port per attempt, so the identity is registered
  // against the whole loopback callback path rather than one port that will not come round again.
  const redirectUri = "http://127.0.0.1/oauth/callback";
  const identity = await register(deps.store, deps.owner, parsed.id, metadata, redirectUri, deps.policy, fetchImpl);
  const provider: OAuthProvider = {
    id: `mcp-${parsed.id}`, label: `the ${parsed.id} server`,
    authorizeUrl: metadata.authorization_endpoint, tokenUrl: metadata.token_endpoint,
    clientId: identity.clientId, scopes: parsed.scopes.length ? parsed.scopes : metadata.scopes_supported ?? [],
    extra: {}, ...(identity.clientSecret ? { clientSecret: identity.clientSecret } : {}),
  };
  const started = await deps.connections.start(provider);
  return { ...started, registered: identity.clientId };
}
