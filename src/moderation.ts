import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";

/**
 * An optional extra check on messages the assistant sends out. When the model provider offers an
 * OpenAI-compatible `/moderations` address, the text is shown to it first and the owner decides
 * whether a flagged message is only noted or held back. Switched off until the owner turns it on.
 */
export const ModerationSchema = z.object({
  enabled: z.boolean().default(false),
  /** The provider's moderation address, for example https://api.openai.com/v1/moderations. */
  endpoint: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(100).default("omni-moderation-latest"),
  /** Where the key lives: a reference such as secret://default/OPENAI_API_KEY. */
  keyReference: z.string().max(200).optional(),
  /** What to do with a message the provider flags. */
  action: z.enum(["warn", "block"]).default("block"),
  timeoutMs: z.number().int().min(500).max(30000).default(8000),
}).strict();
export type ModerationConfig = z.infer<typeof ModerationSchema>;
export interface ModerationVerdict { checked: boolean; flagged: boolean; categories: string[]; blocked: boolean; reason?: string }

export class Moderation {
  private config: ModerationConfig;
  constructor(input: unknown = {}, private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    /** Turns a secret reference into the real key, at the moment of the call. */
    private readonly key: (reference: string) => Promise<string> = async () => "") {
    this.config = ModerationSchema.parse(input);
  }
  configure(input: unknown): ModerationConfig { return (this.config = ModerationSchema.parse(input)); }
  settings(): ModerationConfig { return this.config; }

  /** Asks the provider about one outgoing message. A check that cannot run never blocks a message. */
  async check(text: string): Promise<ModerationVerdict> {
    const { enabled, endpoint, action } = this.config;
    if (!enabled || !endpoint || !text.trim()) return { checked: false, flagged: false, categories: [], blocked: false };
    try {
      const body = await this.ask(endpoint, text);
      const first = (Array.isArray(body.results) ? body.results[0] : undefined) as { flagged?: unknown; categories?: Record<string, unknown> } | undefined;
      const flagged = first?.flagged === true;
      const categories = Object.entries(first?.categories ?? {}).filter(([, on]) => on === true).map(([name]) => name);
      return { checked: true, flagged, categories, blocked: flagged && action === "block" };
    } catch (error) {
      return { checked: false, flagged: false, categories: [], blocked: false, reason: error instanceof Error ? error.message : "The check could not run" };
    }
  }
  private async ask(endpoint: string, text: string): Promise<{ results?: unknown }> {
    const target = new URL(endpoint);
    await this.policy.assertAllowed(target, "moderation address");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.keyReference) headers.authorization = `Bearer ${await this.key(this.config.keyReference)}`;
    const response = await this.fetchImpl(target, { method: "POST", headers, redirect: "error",
      body: JSON.stringify({ model: this.config.model, input: text.slice(0, 20000) }),
      signal: AbortSignal.timeout(this.config.timeoutMs) });
    if (!response.ok) throw new Error(`The moderation check answered ${response.status}`);
    return await response.json() as { results?: unknown };
  }
}
