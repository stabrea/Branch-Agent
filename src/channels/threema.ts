import { z } from "zod";
import type { ChannelHealth } from "./router.js";
import { defineService, secretName, SendOnlyChannel } from "./parity-common.js";

/**
 * Threema, through the Threema Gateway in its Basic mode: Threema encrypts on the owner's behalf,
 * so Branch only needs the Gateway ID and its secret. Basic mode can only send; receiving, and the
 * end-to-end mode, need NaCl encryption that Node does not ship, so they are not built.
 * API: https://gateway.threema.ch/en/developer/api (POST /send_simple).
 */

/** Cuts text to at most `limit` UTF-8 bytes without splitting a character. */
export function cutBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // A byte of the form 10xxxxxx continues a character; step back to where one starts.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * One HTTP call whose answer is plain text. Like `callJson`, the address never appears in an
 * error and a redirect is refused.
 */
export async function callText(fetchImpl: typeof fetch, service: string, url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${service} refused the request (${response.status})`);
  return { status: response.status, text };
}

export interface ThreemaOptions { id: string; gatewayId: string; secret: string; secretName: string; endpoint?: string; fetch?: typeof fetch }

/** Which field names the recipient: a Threema ID, a phone number, or an email address. */
export function threemaRecipient(chatId: string): Record<string, string> {
  const id = chatId.trim();
  // A phone number is written with its leading +, so eight digits alone read as a Threema ID.
  if (/^[0-9A-Z*][0-9A-Z]{7}$/.test(id.toUpperCase())) return { to: id.toUpperCase() };
  if (/^\+[1-9]\d{6,14}$/.test(id)) return { phone: id.slice(1) };
  if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(id)) return { email: id.toLowerCase() };
  throw new Error("Threema can send to a Threema ID (8 letters and digits), a phone number, or an email address");
}

export class ThreemaChannel extends SendOnlyChannel {
  readonly kind = "threema";
  readonly maxTextLength = 3500;
  private readonly fetchImpl: typeof fetch;
  private problem: string | null = null;
  constructor(private readonly options: ThreemaOptions) {
    super(options.id, "Threema Gateway");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  override health(): ChannelHealth {
    return this.problem ? { state: "needs attention", reason: this.problem } : super.health();
  }
  /** The chat id is the person to write to. */
  async send(chatId: string, text: string): Promise<string | undefined> {
    const form = { from: this.options.gatewayId, ...threemaRecipient(chatId), secret: this.options.secret, text: cutBytes(text, 3500) };
    try {
      const answer = await callText(this.fetchImpl, "Threema", this.options.endpoint ?? "https://msgapi.threema.ch/send_simple", {
        method: "POST", body: new URLSearchParams(form).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "*/*" },
      });
      this.problem = null;
      const id = answer.text.trim();
      return /^[0-9a-f]{16}$/i.test(id) ? id : undefined;
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/\(401\)/.test(said)) this.problem = `Threema refused the Gateway ID or its secret. Check ${this.options.gatewayId} and save the secret as ${this.options.secretName}`;
      if (/\(402\)/.test(said)) this.problem = "The Threema Gateway account has no credits left. Buy more in the Gateway admin page";
      if (/\(404\)/.test(said)) throw new Error("Threema could not find that person (the phone number or email is not linked to a Threema ID)");
      throw error;
    }
  }
}

export const threemaService = defineService({
  kind: "threema", name: "Threema Gateway", docs: "https://gateway.threema.ch/en/developer/api",
  needs: ["A Threema Gateway ID in Basic mode (it starts with *), bought at gateway.threema.ch",
    "The Gateway ID's secret, saved as a secret", "Credits in the Gateway account; each message uses one"],
  receives: "send only",
  settings: z.object({
    gatewayId: z.string().regex(/^\*[0-9A-Z]{7}$/),
    gatewaySecret: z.string().regex(secretName).default("THREEMA_GATEWAY_SECRET"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL("https://msgapi.threema.ch/send_simple"), "Threema Gateway");
    return new ThreemaChannel({ id: deps.id, gatewayId: settings.gatewayId, secret: await deps.secret(settings.gatewaySecret),
      secretName: settings.gatewaySecret, fetch: deps.fetch });
  },
});
