import { createSign } from "node:crypto";
import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { TokenSource } from "./github.js";

/**
 * GitHub App integration (A2227): exchange a private key and app ID for installation tokens without
 * storing the owner's personal access token.
 *
 * - The private key is only ever read from the locker, by the secret name saved in the settings,
 *   at the moment a token is needed; it is never kept, logged or put in an error.
 * - The exchange goes to the saved GitHub address, after the network rules allow it.
 * - Installation tokens are kept in memory until 5 minutes before they expire.
 * - Off (the default) means the personal token is used, exactly as before.
 */
export const GitHubAppConfigSchema = z.object({
  appId: z.string().regex(/^\d{1,20}$/, "GitHub App ID is a number").optional(),
  privateKeySecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  installationId: z.string().regex(/^\d{1,20}$/, "Installation ID is a number").optional(),
}).strict();
export type GitHubAppConfig = z.infer<typeof GitHubAppConfigSchema>;

export class GitHubAppAccess {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  constructor(
    private readonly config: { appId: string; privateKeySecret: string; installationId: string },
    private readonly policy: NetworkPolicy,
    private readonly secret: (name: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly userAgent = "BranchAgent",
    private readonly apiBase = "https://api.github.com",
  ) {}

  /** An installation token, kept until 5 minutes before it expires. */
  async getInstallationToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 300_000) return this.cachedToken.token;

    const pem = await this.secret(this.config.privateKeySecret).catch(() => "");
    if (!pem) throw new Error(`Save the GitHub App's private key in the locker as ${this.config.privateKeySecret} first.`);
    const jwt = signAppJwt(pem, this.config.appId, this.now());
    const url = new URL(`app/installations/${this.config.installationId}/access_tokens`, this.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitHub address");
    const response = await this.fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json",
        "user-agent": this.userAgent, "x-github-api-version": "2022-11-28",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      // Scrubbed before it is cut short, so a key split by the cut cannot slip through; any key block is dropped too.
      const scrubbed = scrubSecrets(text.slice(0, 65536), { jwt, key: pem }).replace(/-----BEGIN[^-]*-----[\s\S]*?(-----END[^-]*-----|$)/g, "[a key]");
      throw new Error(`GitHub did not hand over an app token (${response.status}): ${scrubbed.slice(0, 300)}`);
    }
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("GitHub answered the app token request with something unreadable."); }
    const token = String(data.token ?? "");
    const expiresAt = new Date(String(data.expires_at ?? "")).getTime();
    if (!token) throw new Error("GitHub App did not return a token");
    if (!expiresAt || expiresAt <= now) throw new Error("GitHub App returned an invalid expiration");

    this.cachedToken = { token, expiresAt };
    return token;
  }

}

/** A signed app token (JWT) valid for 9 minutes, dated a minute back for clock drift. A bad key fails without quoting it. */
export function signAppJwt(pem: string, appId: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: unknown) => base64urlNoPadding(Buffer.from(JSON.stringify(value)).toString("base64"));
  const signatureInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: appId, iat: now - 60, exp: now + 540 })}`;
  try {
    const signer = createSign("sha256");
    signer.update(signatureInput);
    return `${signatureInput}.${base64urlNoPadding(signer.sign(pem, "base64"))}`;
  } catch {
    throw new Error("The GitHub App's private key in the locker could not be read as a private key.");
  }
}

/** Convert base64 to base64url (no padding) for JWT compliance. */
function base64urlNoPadding(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export const GitHubAppSettingsSchema = GitHubAppConfigSchema.extend({
  mode: z.enum(["off", "when-needed", "on"]).default("off"),
}).strict();

/**
 * Where GitHub tokens come from. Off: the personal token. When needed: the app when all three of its
 * details are saved, otherwise the personal token. On: the app, and a clear refusal when it is not set
 * up. A failing app never falls back quietly to the personal token; the reason is said instead.
 */
export function chooseGitHubTokenSource(input: unknown, personal: TokenSource, policy: NetworkPolicy,
  secret: (name: string) => Promise<string>, options: { apiBase?: string; fetchImpl?: typeof fetch } = {}): TokenSource {
  const settings = GitHubAppSettingsSchema.parse(input ?? {});
  if (settings.mode === "off") return personal;
  const { appId, privateKeySecret, installationId } = settings;
  if (!appId || !privateKeySecret || !installationId) {
    if (settings.mode === "when-needed") return personal;
    return async () => { throw new Error("The GitHub App is switched on but its app number, installation number or key name is missing."); };
  }
  const app = new GitHubAppAccess({ appId, privateKeySecret, installationId }, policy, secret,
    options.fetchImpl ?? globalThis.fetch, () => Date.now(), "BranchAgent", options.apiBase ?? "https://api.github.com");
  return () => app.getInstallationToken();
}
