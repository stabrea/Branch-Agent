import { z } from "zod";
import type { Store } from "./store.js";
import { PiiGuardSchema, applyPiiGuard, type PiiFinding, type PiiGuardConfig } from "./pii.js";
import { mapStrings } from "./vault.js";
import { ModerationSchema, type Moderation, type ModerationVerdict } from "./moderation.js";

/**
 * The privacy check that sits either side of the assistant. On the way out (a message to a chat or
 * a mailbox) personal details are hidden by default and, if the owner has switched it on, the
 * provider is asked whether the message is acceptable. On the way in (what the assistant reads)
 * nothing is changed unless the owner asks for it, because reading your own files should not be
 * rewritten behind your back.
 */
export const PrivacyGuardSchema = z.object({
  pii: PiiGuardSchema.prefault({}),
  moderation: ModerationSchema.prefault({}),
}).strict();
export type PrivacyGuardConfig = z.infer<typeof PrivacyGuardSchema>;
export interface OutboundCheck {
  text: string; blocked: boolean; reason?: string;
  findings: PiiFinding[]; moderation: ModerationVerdict | null;
}
const settingsKey = "privacy-guard";

export class PrivacyGuard {
  constructor(private readonly store: Store, private readonly owner: string, private readonly moderation: Moderation) {}
  settings(): PrivacyGuardConfig {
    const saved = PrivacyGuardSchema.safeParse(this.store.get("settings", this.owner, settingsKey)?.data ?? {});
    return saved.success ? saved.data : PrivacyGuardSchema.parse({});
  }
  configure(input: unknown): PrivacyGuardConfig {
    const next = PrivacyGuardSchema.parse(input ?? {});
    this.store.save("settings", this.owner, settingsKey, next);
    this.moderation.configure(next.moderation);
    return next;
  }
  private pii(): PiiGuardConfig { return this.settings().pii; }

  /** Everything the assistant is about to send out of this computer goes through here. */
  async outbound(text: string): Promise<OutboundCheck> {
    const rules = this.pii();
    const verdict = applyPiiGuard(text, rules.outbound, rules.kinds);
    if (verdict.blocked)
      return { text: "", blocked: true, findings: verdict.findings, moderation: null,
        reason: `The message was held back because it contains a ${verdict.findings[0]?.hint ?? "personal detail"}.` };
    const checked = await this.moderation.check(verdict.text);
    if (checked.blocked)
      return { text: "", blocked: true, findings: verdict.findings, moderation: checked,
        reason: `The message was held back by the content check (${checked.categories.join(", ") || "flagged"}).` };
    return { text: verdict.text, blocked: false, findings: verdict.findings, moderation: checked.checked ? checked : null };
  }
  /** What the assistant reads. Left exactly as it is unless the owner has asked for masking. */
  inbound<T>(value: T): T {
    const rules = this.pii();
    if (rules.inbound === "off" || rules.inbound === "warn") return value;
    return mapStrings(value, (text) => applyPiiGuard(text, rules.inbound, rules.kinds).text);
  }
}
