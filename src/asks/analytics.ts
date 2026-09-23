import { z } from "zod";
import { optionalFields } from "../feature-switches.js"; // Q65
import type { Store } from "../store.js";
import { askMode, partSettings } from "./settings.js";

/**
 * A0504 and A1620: counting how Branch is used, only with the owner's consent, and sending the
 * counts only to an address of the owner's own. Three things must all be true before anything is
 * counted: the switch is not off, the owner said yes to the plain question, and the event is one of
 * the fixed names below. What is kept is a count per event per day — never a prompt, a file name,
 * an address or anything a person typed — so there is nothing personal to leak. Saying no, or
 * withdrawing a yes, wipes every count at once.
 */
export const analyticsEvents = [
  "task.finished", "task.failed", "place.opened", "settings.opened", "conversation.started", "feature.switched",
] as const;
export type AnalyticsEvent = (typeof analyticsEvents)[number];
export const AnalyticsEventSchema = z.enum(analyticsEvents);

export const AnalyticsSettingsSchema = z.object({
  consent: z.enum(["not-asked", "yes", "no"]).default("not-asked"),
  decidedAt: z.string().nullable().default(null),
  /** The owner's own collector; counts are never sent anywhere else, and not at all while empty. */
  sendTo: z.string().url().max(2048).regex(/^https:\/\//, "Use an https address").nullable().default(null),
  lastSentAt: z.string().nullable().default(null),
}).strict();
export type AnalyticsSettings = z.infer<typeof AnalyticsSettingsSchema>;
const settingsKey = "asks-analytics-settings";
export const consentQuestion =
  "May Branch count how often you use its parts (tasks finished, places opened)? Only counts per day are kept, never what you typed, and they go nowhere unless you name an address of your own.";

export interface DailyCount { day: string; event: AnalyticsEvent; count: number }

export class Analytics {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS asks_analytics(owner TEXT NOT NULL, day TEXT NOT NULL, event TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner, day, event))`);
  }
  settings(): AnalyticsSettings & { question: string } {
    return { ...partSettings(this.store, this.owner, settingsKey, AnalyticsSettingsSchema), question: consentQuestion };
  }
  /** Consent and the address. A no (or a withdrawn yes) wipes what was counted. */
  save(input: unknown): AnalyticsSettings & { question: string } {
    // Q65: only what was sent. `.partial()` filled the other with its default, so saving the address
    // answered "not asked" (and wiped the counts), and answering the question cleared the address.
    const change = optionalFields(AnalyticsSettingsSchema.pick({ consent: true, sendTo: true })).parse(input);
    const current = this.settings();
    const next: AnalyticsSettings = {
      consent: change.consent ?? current.consent,
      decidedAt: change.consent && change.consent !== current.consent ? new Date().toISOString() : current.decidedAt,
      sendTo: change.sendTo === undefined ? current.sendTo : change.sendTo,
      lastSentAt: current.lastSentAt,
    };
    this.store.save("settings", this.owner, settingsKey, next);
    if (next.consent !== "yes") this.erase();
    return { ...next, question: consentQuestion };
  }
  /** Whether a count would be kept right now. */
  counting(): boolean {
    return askMode(this.store, this.owner, "analytics") !== "off" && this.settings().consent === "yes";
  }
  /** Adds one to today's count for a known event; anything else is ignored rather than stored. */
  track(event: unknown, at = new Date()): boolean {
    const name = AnalyticsEventSchema.safeParse(event);
    if (!name.success || !this.counting()) return false;
    this.store.sqlite.prepare(`INSERT INTO asks_analytics VALUES(?,?,?,1)
      ON CONFLICT(owner, day, event) DO UPDATE SET count = count + 1`).run(this.owner, at.toISOString().slice(0, 10), name.data);
    return true;
  }
  counts(days = 30): DailyCount[] {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return this.store.sqlite.prepare("SELECT day, event, count FROM asks_analytics WHERE owner=? AND day>=? ORDER BY day DESC, event")
      .all(this.owner, since).map((row) => ({ day: String(row.day), event: String(row.event) as AnalyticsEvent, count: Number(row.count) }));
  }
  erase(): number {
    return Number(this.store.sqlite.prepare("DELETE FROM asks_analytics WHERE owner=?").run(this.owner).changes);
  }
  /** Sends the last month's counts to the owner's own address; the fetch given is the policed one. */
  async send(): Promise<{ sent: boolean; reason: string; days: number }> {
    const settings = this.settings();
    if (!this.counting()) return { sent: false, reason: "Counting is off or you have not said yes, so there is nothing to send.", days: 0 };
    if (!settings.sendTo) return { sent: false, reason: "There is no address of yours to send the counts to.", days: 0 };
    const counts = this.counts();
    const response = await this.fetcher(settings.sendTo, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "branch-agent", counts }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { sent: false, reason: `Your collector answered ${response.status}.`, days: 0 };
    this.store.save("settings", this.owner, settingsKey, { ...partSettings(this.store, this.owner, settingsKey, AnalyticsSettingsSchema), lastSentAt: new Date().toISOString() });
    return { sent: true, reason: "Sent.", days: new Set(counts.map((c) => c.day)).size };
  }
}
