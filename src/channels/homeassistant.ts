import { z } from "zod";
import type { ChannelHealth } from "./router.js";
import { callJson, defineService, secretName, SendOnlyChannel } from "./parity-common.js";

/**
 * Home Assistant's notify services: Branch calls `notify.<service>` (the companion app on a phone,
 * a smart speaker, and so on) with a long-lived access token. Nothing can write back.
 * A chat id made only of lower-case letters, digits and underscores picks a different notify
 * service; anything else goes to the one in the settings.
 * API: https://developers.home-assistant.io/docs/api/rest/ (POST /api/services/<domain>/<service>).
 */
export interface HomeAssistantOptions {
  id: string;
  url: string;
  token: string;
  tokenSecret: string;
  service: string;
  title: string;
  fetch?: typeof fetch;
}
export const notifyServiceName = /^[a-z0-9_]+$/;

export class HomeAssistantChannel extends SendOnlyChannel {
  readonly kind = "homeassistant";
  readonly maxTextLength = 3500;
  private readonly fetchImpl: typeof fetch;
  private problem: string | null = null;
  constructor(private readonly options: HomeAssistantOptions) {
    super(options.id, "Home Assistant");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  override health(): ChannelHealth {
    return this.problem ? { state: "needs attention", reason: this.problem } : super.health();
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const service = notifyServiceName.test(chatId) && chatId.length <= 64 ? chatId : this.options.service;
    await callJson(this.fetchImpl, "Home Assistant", `${this.options.url.replace(/\/+$/, "")}/api/services/notify/${service}`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}` },
      json: { message: text.slice(0, this.maxTextLength), title: this.options.title },
    }).catch((error: unknown) => {
      const said = error instanceof Error ? error.message : String(error);
      if (/\((401|403)\)/.test(said)) this.problem = `Home Assistant refused the access token. Make a new long-lived access token and save it as ${this.options.tokenSecret}`;
      if (/\((400|404)\)/.test(said)) throw new Error(`Home Assistant has no notify service called ${service}`);
      throw error;
    });
    this.problem = null;
    return undefined;
  }
}

export const homeassistantService = defineService({
  kind: "homeassistant", name: "Home Assistant", docs: "https://developers.home-assistant.io/docs/api/rest/",
  needs: ["The address of your Home Assistant", "A long-lived access token (your profile, Security), saved as a secret",
    "The notify service to use, such as mobile_app_your_phone"],
  receives: "send only",
  settings: z.object({
    url: z.string().url(),
    tokenSecret: z.string().regex(secretName).default("HOMEASSISTANT_TOKEN"),
    service: z.string().regex(notifyServiceName).max(64).default("notify"),
    title: z.string().min(1).max(80).default("Branch"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.url), "Home Assistant");
    return new HomeAssistantChannel({ id: deps.id, url: settings.url, token: await deps.secret(settings.tokenSecret),
      tokenSecret: settings.tokenSecret, service: settings.service, title: settings.title, fetch: deps.fetch });
  },
});
