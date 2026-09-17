import { z } from "zod";
import { callJson, defineService, secretName, SendOnlyChannel } from "./parity-common.js";

/**
 * Gotify, a notification server people run themselves. An application token lets Branch post a
 * message; Gotify has no way for a person to write back, so this is a way to reach the owner only.
 * API: https://gotify.net/api-docs (POST /message with the X-Gotify-Key header).
 */
export interface GotifyOptions { id: string; server: string; token: string; title: string; priority: number; fetch?: typeof fetch }

export class GotifyChannel extends SendOnlyChannel {
  readonly kind = "gotify";
  readonly maxTextLength = 3500;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: GotifyOptions) {
    super(options.id, "Gotify");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  /** The chat id is ignored: an application token always posts to the same place. */
  async send(_chatId: string, text: string): Promise<string | undefined> {
    const answer = await callJson(this.fetchImpl, "Gotify", `${this.options.server.replace(/\/$/, "")}/message`, {
      method: "POST", headers: { "x-gotify-key": this.options.token },
      json: { title: this.options.title, message: text.slice(0, this.maxTextLength), priority: this.options.priority },
    });
    const id = z.object({ id: z.number() }).passthrough().safeParse(answer);
    return id.success ? String(id.data.id) : undefined;
  }
}

export const gotifyService = defineService({
  kind: "gotify", name: "Gotify", docs: "https://gotify.net/docs/pushmsg",
  needs: ["The address of your Gotify server", "An application token made in Gotify, saved as a secret"],
  receives: "send only",
  settings: z.object({
    server: z.string().url(),
    tokenSecret: z.string().regex(secretName).default("GOTIFY_APP_TOKEN"),
    title: z.string().min(1).max(80).default("Branch"),
    priority: z.number().int().min(0).max(10).default(5),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.server), "Gotify server");
    return new GotifyChannel({ id: deps.id, server: settings.server, token: await deps.secret(settings.tokenSecret),
      title: settings.title, priority: settings.priority, fetch: deps.fetch });
  },
});
