import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * ChatGPT account sign-in through OpenAI's device-code flow, with the client id OpenAI's Codex uses.
 * Hermes Agent does the same (same client id and device code, its own originator); Goose uses the
 * same client id with a browser sign-in instead. Branch identifies itself honestly with its own
 * originator; it never impersonates Codex. Tokens stay in the vault and are never returned to the
 * interface.
 *
 * Terms: UNOFFICIAL. OpenAI documents this sign-in only for its own apps
 * (https://learn.chatgpt.com/docs/auth) and gives no written permission to other apps, so the route
 * is opt-in, labelled "unofficial, may stop working" wherever it is shown, and may stop at any time.
 * See docs/configuration.md, "ChatGPT plan sign-in and OpenAI's terms".
 */
export const chatgptDefaults = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  verificationUrl: "https://auth.openai.com/codex/device",
  apiBase: "https://chatgpt.com/backend-api/codex",
  originator: "branch-agent",
  refreshSkewMs: 120_000,
  loginTimeoutMs: 15 * 60_000,
} as const;

export interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string | undefined;
  expiresAt: string;
}
export interface TokenVault {
  read(): Promise<ChatGPTTokens | null>;
  write(tokens: ChatGPTTokens): Promise<void>;
  clear(): Promise<void>;
}
export interface ValueProtection {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export interface DevicePrompt {
  userCode: string;
  verificationUrl: string;
  deviceAuthId: string;
  intervalMs: number;
  expiresAt: string;
}
export interface ChatGPTStatus {
  signedIn: boolean;
  email: string | null;
  accountId: string | null;
  expiresAt: string | null;
  pending: { userCode: string; verificationUrl: string; expiresAt: string } | null;
  lastError: string | null;
}
const tokenSchema = z.object({
  accessToken: z.string().min(1).max(16384),
  refreshToken: z.string().min(1).max(16384),
  idToken: z.string().max(16384).optional(),
  expiresAt: z.string().datetime(),
}).strict();
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
const deviceResponse = z.object({
  user_code: z.string().min(1),
  device_auth_id: z.string().min(1),
  interval: z.coerce.number().optional(),
  expires_in: z.coerce.number().optional(),
});
const pollResponse = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) });

/** Plain or protected JSON file; the plain form is only for headless setups without device key storage. */
export class FileTokenVault implements TokenVault {
  constructor(private readonly path: string, private readonly protection?: ValueProtection) {}
  async read(): Promise<ChatGPTTokens | null> {
    let raw: Buffer;
    try { raw = await readFile(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (raw.length > 131072) throw new Error("ChatGPT sign-in file is too large");
    const envelope = z.object({ protected: z.boolean(), value: z.string() }).parse(JSON.parse(raw.toString("utf8")));
    const text = envelope.protected
      ? this.protection!.decrypt(Buffer.from(envelope.value, "base64"))
      : Buffer.from(envelope.value, "base64").toString("utf8");
    return tokenSchema.parse(JSON.parse(text));
  }
  async write(tokens: ChatGPTTokens): Promise<void> {
    const text = JSON.stringify(tokenSchema.parse(tokens));
    const protectedValue = this.protection?.available() ?? false;
    const value = protectedValue ? this.protection!.encrypt(text).toString("base64") : Buffer.from(text).toString("base64");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ protected: protectedValue, value }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
}

export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split(".")[1];
  if (!part) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
export function chatgptAccountId(accessToken: string): string | null {
  const auth = jwtClaims(accessToken)["https://api.openai.com/auth"];
  const id = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof id === "string" && id ? id : null;
}

export interface ChatGPTAuthOptions {
  fetch?: typeof fetch;
  issuer?: string;
  clientId?: string;
  verificationUrl?: string;
  userAgent?: string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export class ChatGPTAuth {
  private tokens: ChatGPTTokens | null = null;
  private loading: Promise<void> | null = null;
  private pending: DevicePrompt | null = null;
  private lastError: string | null = null;
  private refreshing: Promise<string> | null = null;
  private waiting: Promise<ChatGPTStatus> | null = null;
  private readonly fetch: typeof fetch;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly verificationUrl: string;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(private readonly vault: TokenVault, options: ChatGPTAuthOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.issuer = options.issuer ?? chatgptDefaults.issuer;
    this.clientId = options.clientId ?? chatgptDefaults.clientId;
    this.verificationUrl = options.verificationUrl ?? chatgptDefaults.verificationUrl;
    this.userAgent = options.userAgent ?? "BranchAgent";
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }
  /** Reads the vault once; concurrent callers share the same read. */
  load(): Promise<void> {
    return this.loading ??= this.readVault();
  }
  private async readVault(): Promise<void> {
    try { this.tokens = await this.vault.read(); } catch {
      this.tokens = null;
      this.lastError = "Saved ChatGPT sign-in could not be read. Sign in again.";
    }
  }
  async status(): Promise<ChatGPTStatus> {
    await this.load();
    const email = jwtClaims(this.tokens?.idToken).email;
    return {
      signedIn: !!this.tokens,
      email: typeof email === "string" ? email : null,
      accountId: this.tokens ? chatgptAccountId(this.tokens.accessToken) : null,
      expiresAt: this.tokens?.expiresAt ?? null,
      pending: this.pending
        ? { userCode: this.pending.userCode, verificationUrl: this.pending.verificationUrl, expiresAt: this.pending.expiresAt }
        : null,
      lastError: this.lastError,
    };
  }
  /** Step 1: ask OpenAI for a one-time code the person types into their browser. */
  async startDeviceLogin(): Promise<DevicePrompt> {
    await this.load();
    if (this.pending && new Date(this.pending.expiresAt).getTime() > this.now()) return this.pending;
    const response = await this.post(`${this.issuer}/api/accounts/deviceauth/usercode`,
      JSON.stringify({ client_id: this.clientId }), "application/json");
    if (response.status === 429) throw new Error("OpenAI is limiting sign-in attempts right now. Wait a minute and try again.");
    if (!response.ok) throw new Error(`ChatGPT sign-in could not start (HTTP ${response.status})`);
    const data = deviceResponse.parse(await response.json());
    const ttl = Math.min((data.expires_in ?? 900) * 1000, chatgptDefaults.loginTimeoutMs);
    this.pending = {
      userCode: data.user_code, deviceAuthId: data.device_auth_id, verificationUrl: this.verificationUrl,
      intervalMs: Math.max(3, data.interval ?? 5) * 1000, expiresAt: new Date(this.now() + ttl).toISOString(),
    };
    this.lastError = null;
    return this.pending;
  }
  /** Steps 2 to 4: wait for the browser approval, exchange the code, keep the tokens in the vault. */
  waitForDeviceLogin(signal?: AbortSignal): Promise<ChatGPTStatus> {
    return this.waiting ??= this.runDeviceLogin(signal).finally(() => { this.waiting = null; });
  }
  private async runDeviceLogin(signal?: AbortSignal): Promise<ChatGPTStatus> {
    const prompt = this.pending;
    if (!prompt) throw new Error("Start the ChatGPT sign-in first");
    try {
      const approval = await this.pollApproval(prompt, signal);
      const tokens = await this.exchange({
        grant_type: "authorization_code", code: approval.authorization_code, code_verifier: approval.code_verifier,
        redirect_uri: `${this.issuer}/deviceauth/callback`, client_id: this.clientId,
      });
      await this.store(tokens);
      this.pending = null;
      return this.status();
    } catch (error) {
      this.pending = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  private async pollApproval(prompt: DevicePrompt, signal?: AbortSignal) {
    while (this.now() < new Date(prompt.expiresAt).getTime()) {
      await this.sleep(prompt.intervalMs, signal);
      signal?.throwIfAborted();
      const response = await this.post(`${this.issuer}/api/accounts/deviceauth/token`,
        JSON.stringify({ device_auth_id: prompt.deviceAuthId, user_code: prompt.userCode }), "application/json");
      if (response.status === 200) return pollResponse.parse(await response.json());
      if (![403, 404].includes(response.status))
        throw new Error(`ChatGPT sign-in was interrupted (HTTP ${response.status}). Try again.`);
    }
    throw new Error("ChatGPT sign-in timed out. Start it again when you are ready.");
  }
  /** A valid access token, refreshed ahead of expiry. Refresh tokens rotate, so concurrent callers share one refresh. */
  async accessToken(): Promise<string> {
    await this.load();
    if (!this.tokens) throw new Error("Sign in with ChatGPT first");
    if (new Date(this.tokens.expiresAt).getTime() - this.now() > chatgptDefaults.refreshSkewMs) return this.tokens.accessToken;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    const current = this.tokens!;
    const tokens = await this.exchange({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: this.clientId });
    await this.store({ ...tokens, refreshToken: tokens.refreshToken || current.refreshToken, idToken: tokens.idToken ?? current.idToken });
    return this.tokens!.accessToken;
  }
  private async exchange(form: Record<string, string>): Promise<ChatGPTTokens> {
    const response = await this.post(`${this.issuer}/oauth/token`, new URLSearchParams(form).toString(), "application/x-www-form-urlencoded");
    if (response.status === 401 || response.status === 400) {
      if (form.grant_type === "refresh_token") { this.tokens = null; await this.vault.clear(); }
      throw new Error("ChatGPT sign-in is no longer valid. Sign in again.");
    }
    if (!response.ok) throw new Error(`ChatGPT sign-in failed (HTTP ${response.status})`);
    const data = tokenResponse.parse(await response.json());
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token ?? "",
      ...(data.id_token ? { idToken: data.id_token } : {}),
      expiresAt: new Date(this.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    };
  }
  private async store(tokens: ChatGPTTokens): Promise<void> {
    if (!tokens.refreshToken) throw new Error("ChatGPT did not return a refresh token");
    await this.vault.write(tokens);
    this.tokens = tokens;
    this.lastError = null;
  }
  async signOut(): Promise<ChatGPTStatus> {
    this.tokens = null;
    this.pending = null;
    this.lastError = null;
    await this.vault.clear();
    return this.status();
  }
  private post(url: string, body: string, contentType: string): Promise<Response> {
    return this.fetch(url, {
      method: "POST", body, redirect: "error",
      headers: { "content-type": contentType, "user-agent": this.userAgent, originator: chatgptDefaults.originator },
      signal: AbortSignal.timeout(15000),
    });
  }
}
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { setTimeout: wait } = await import("node:timers/promises");
  await wait(ms, undefined, { signal });
}
