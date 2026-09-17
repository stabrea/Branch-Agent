import { z } from "zod";
import type { ChannelHealth } from "./router.js";
import { callJson, defineService, secretName, SendOnlyChannel } from "./parity-common.js";

/**
 * Pushover, a push notification app for phones and desktops. An application token and the owner's
 * user key let Branch send a notification; nobody can write back, so the chat id is ignored.
 * API: https://pushover.net/api (POST /1/messages.json).
 */
export interface PushoverOptions {
  id: string;
  appToken: string;
  userKey: string;
  title: string;
  appTokenSecret: string;
  userKeySecret: string;
  endpoint?: string;
  fetch?: typeof fetch;
}
const AnswerSchema = z.object({ status: z.number(), request: z.string().max(64).optional() }).passthrough();

export class PushoverChannel extends SendOnlyChannel {
  readonly kind = "pushover";
  /** Pushover cuts a message at 1024 characters. */
  readonly maxTextLength = 1024;
  private readonly fetchImpl: typeof fetch;
  private problem: string | null = null;
  constructor(private readonly options: PushoverOptions) {
    super(options.id, "Pushover");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  override health(): ChannelHealth {
    return this.problem ? { state: "needs attention", reason: this.problem } : super.health();
  }
  async send(_chatId: string, text: string): Promise<string | undefined> {
    const answer = await callJson(this.fetchImpl, "Pushover", this.options.endpoint ?? "https://api.pushover.net/1/messages.json", {
      method: "POST",
      form: { token: this.options.appToken, user: this.options.userKey, message: text.slice(0, this.maxTextLength), title: this.options.title.slice(0, 250) },
    }).catch((error: unknown) => {
      if (/\((400|401)\)/.test(error instanceof Error ? error.message : String(error)))
        this.problem = `Pushover refused the application token or user key. Check them and save them as ${this.options.appTokenSecret} and ${this.options.userKeySecret}`;
      throw error;
    });
    this.problem = null;
    const parsed = AnswerSchema.safeParse(answer);
    return parsed.success && parsed.data.request ? parsed.data.request : undefined;
  }
}

export const pushoverService = defineService({
  kind: "pushover", name: "Pushover", docs: "https://pushover.net/api",
  needs: ["An application made at pushover.net/apps/build; its API token saved as a secret",
    "Your user key from the Pushover dashboard, saved as a secret"],
  receives: "send only",
  settings: z.object({
    appTokenSecret: z.string().regex(secretName).default("PUSHOVER_APP_TOKEN"),
    userKeySecret: z.string().regex(secretName).default("PUSHOVER_USER_KEY"),
    title: z.string().min(1).max(250).default("Branch"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL("https://api.pushover.net/1/messages.json"), "Pushover");
    return new PushoverChannel({ id: deps.id, appToken: await deps.secret(settings.appTokenSecret), userKey: await deps.secret(settings.userKeySecret),
      title: settings.title, appTokenSecret: settings.appTokenSecret, userKeySecret: settings.userKeySecret, fetch: deps.fetch });
  },
});
