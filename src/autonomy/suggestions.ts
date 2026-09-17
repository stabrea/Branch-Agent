import { blueprint, fillSlots } from "./blueprints.js";
import { fingerprintOf, type Ledger } from "./ledger.js";
import { quoteLine } from "./settings.js";

/**
 * R17-015: automations worth offering, worked out on this computer from what Branch remembers and
 * what is connected. No model is asked, so it costs nothing.
 *
 * - Every suggestion is a filled blueprint the owner can accept with one press.
 * - Its fingerprint is the blueprint and the kind of hint behind it, never the fact's own id, so the
 *   same idea found again tomorrow in another fact is the same suggestion. A "no" is kept for good
 *   (src/autonomy/ledger.ts), so a dismissed idea is never offered again.
 * - At most five are offered at once. What a fact says is only matched, and a word taken from it is
 *   shown to the owner before anything is made.
 *
 * Hermes Agent (`cron/suggestions.py`, MIT) and IronClaw (`ironclaw_assistant/src/suggestions.rs`,
 * MIT/Apache-2.0) were studied; neither has code here.
 */
export interface Signals {
  facts: readonly string[];
  tools: readonly string[];
  chats: readonly { channel: string; chatId: string; title: string }[];
  /** Blueprints the owner already turned into automations. */
  inUse: ReadonlySet<string>;
}

export interface Suggestion {
  fingerprint: string;
  blueprint: string;
  title: string;
  why: string;
  values: Record<string, string>;
  deliverTo?: { channel: string; chatId: string };
}

interface Rule {
  blueprint: string;
  key: string;
  why: string;
  memory?: RegExp;
  tools?: RegExp;
  /** A blank filled from the matched words (the rule's first group). */
  fill?: string;
}

const RULES: readonly Rule[] = [
  { blueprint: "important-mail", key: "tools:mail", tools: /(^|[._-])(mail|gmail|imap|inbox|outlook)([._-]|$)/i, why: "A mail connection is set up." },
  { blueprint: "morning-brief", key: "tools:calendar", tools: /calendar/i, why: "A calendar connection is set up." },
  { blueprint: "bill-renewal-watch", key: "memory:bills", memory: /\b(bills?|renewals?|subscriptions?|invoices?)\b/i, why: "What Branch remembers mentions bills or subscriptions." },
  { blueprint: "news-digest", key: "memory:follows", memory: /\b(?:follows?|following|interested in|keeps? up with)\s+([A-Za-z][\w -]{2,40}?)(?:[.,;!]|$)/i, fill: "topic", why: "What Branch remembers says you follow a subject." },
  { blueprint: "habit-checkin", key: "memory:habit", memory: /\b(go to the gym|work out|exercise|run every day|meditate|do yoga|practise [a-z]+)\b/i, fill: "habit", why: "What Branch remembers mentions a habit." },
  { blueprint: "hydration-move", key: "memory:desk", memory: /\b(drink more water|stay hydrated|sits? all day|desk job)\b/i, why: "What Branch remembers mentions long days at a desk." },
  { blueprint: "workday-start", key: "memory:workday", memory: /\b(stand-?up|work starts|starts? work at|office hours)\b/i, why: "What Branch remembers mentions when your work starts." },
  { blueprint: "learn-daily", key: "memory:learning", memory: /\b(?:learning|studying)\s+([A-Za-z][\w -]{2,30}?)(?:[.,;!]|$)/i, fill: "subject", why: "What Branch remembers says you are learning something." },
  { blueprint: "weekly-review", key: "memory:review", memory: /\b(weekly review|plan(?:s|ning)? (?:my|the|their) week)\b/i, why: "What Branch remembers mentions planning the week." },
];

/** The starter ideas, offered only when the owner asks for them. */
const STARTERS = ["morning-brief", "weekly-review", "workday-start", "evening-winddown"];
export const maxSuggestions = 5;

function matchRule(rule: Rule, signals: Signals): Record<string, string> | null {
  if (rule.tools) return signals.tools.some((name) => rule.tools!.test(name)) ? {} : null;
  for (const fact of signals.facts) {
    const found = rule.memory?.exec(fact);
    if (!found) continue;
    if (!rule.fill) return {};
    const word = quoteLine(found[1] ?? "", 40).replace(/[^\p{L}\p{N} -]/gu, "").trim();
    if (word) return { [rule.fill]: word };
  }
  return null;
}

function build(blueprintId: string, key: string, why: string, values: Record<string, string>, signals: Signals): Suggestion | null {
  const entry = blueprint(blueprintId);
  try { fillSlots(entry, values); } catch { return null; } // one press must be enough: every blank filled
  const chat = [...signals.chats].pop();
  const deliver = chat && entry.kind !== "reminder" ? { channel: chat.channel, chatId: chat.chatId } : undefined;
  return {
    fingerprint: fingerprintOf("suggestion", blueprintId, key), blueprint: blueprintId, title: entry.title, values,
    why: deliver ? `${why} Results would go to ${quoteLine(chat!.title, 60)} on ${chat!.channel}.` : why,
    ...(deliver ? { deliverTo: deliver } : {}),
  };
}

/** What to offer now: never something already answered or already in use, at most five. */
export function suggest(signals: Signals, ledger: Pick<Ledger, "seen">, starters = false): Suggestion[] {
  const found: Suggestion[] = [];
  const add = (made: Suggestion | null): void => {
    if (!made || found.length >= maxSuggestions || signals.inUse.has(made.blueprint)) return;
    if (ledger.seen(made.fingerprint) || found.some((s) => s.blueprint === made.blueprint)) return;
    found.push(made);
  };
  for (const rule of RULES) {
    const values = matchRule(rule, signals);
    if (values) add(build(rule.blueprint, rule.key, rule.why, values, signals));
  }
  if (starters) for (const id of STARTERS) add(build(id, "starter", "A starting idea from the catalogue.", {}, signals));
  return found;
}
