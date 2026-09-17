import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { fingerprintOf, type Ledger } from "./ledger.js";
import { quoteLine } from "./settings.js";

/**
 * R17-021: "From now on, do X". When the owner says that in a conversation, Branch writes it down as
 * one short standing instruction and asks once (Inbox › Needs you) before keeping it. Kept
 * instructions are given to every later task — to the assistant, to one specialist, or to both — and
 * can be read and removed in Settings › Assistant.
 *
 * - Spotting the phrase costs nothing: no model is asked. The instruction is the owner's own words
 *   with the lead-in taken off, on one line, at most 300 characters.
 * - The same instruction is never kept twice (compared without case or punctuation), at most 30 are
 *   kept, and a "no" is never asked again.
 * - The assistant can propose one too (`instructions.propose`), for when the owner asks it to
 *   remember a way of working; that also waits for the owner's yes.
 *
 * The idea of condensing feedback into lasting rules is from CrewAI's `train` (MIT) and Agent Zero's
 * `behaviour_adjustment` tool (MIT); this is written for Branch, without a model call, and keeps each
 * rule separate instead of rewriting one file.
 */
export const ScopeSchema = z.string().regex(/^(assistant|everyone|specialist:[a-zA-Z0-9_.:-]{1,80})$/);
export const InstructionSchema = z.object({
  text: z.string().trim().min(3).max(300),
  scope: ScopeSchema.default("assistant"),
}).strict();

export interface Instruction { id: string; text: string; scope: string; createdAt: string }
const key = "autonomy-instructions";
export const maxInstructions = 30;
const Saved = z.object({ items: z.array(z.object({ id: z.string(), text: z.string(), scope: z.string(), createdAt: z.string() }).strict()) }).strict();

const lead = /(?:^|[.!?]\s+|\n)\s*(?:and\s+)?(from now on|going forward|in (?:the )?future|à partir de maintenant|désormais|dorénavant)\s*[,:]?\s+([^\n.!?]{3,290}[.!?]?)/i;

/** The standing instruction a message asks for, or null. Only the sentence with the lead-in counts. */
export function spotInstruction(message: string): string | null {
  const found = lead.exec(message.slice(0, 4000));
  if (!found) return null;
  const said = quoteLine(found[2] ?? "", 290).replace(/^please\s+/i, "");
  if (said.length < 3 || /\?$/.test(said)) return null;
  const sentence = said.charAt(0).toUpperCase() + said.slice(1);
  return /[.!]$/.test(sentence) ? sentence : `${sentence}.`;
}

const same = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export class Instructions {
  constructor(private readonly store: Store, private readonly owner: string, private readonly ledger: Ledger, private readonly now: () => Date = () => new Date()) {}

  list(): Instruction[] {
    const saved = Saved.safeParse(this.store.get("settings", this.owner, key)?.data);
    return saved.success ? saved.data.items : [];
  }

  /** Keeps one (the owner's yes). The same words already kept are not kept twice. */
  add(input: unknown): Instruction {
    const { text, scope } = InstructionSchema.parse(input);
    const items = this.list();
    const clean = quoteLine(text, 300);
    const existing = items.find((item) => same(item.text) === same(clean) && item.scope === scope);
    if (existing) return existing;
    if (items.length >= maxInstructions) throw new Error(`At most ${maxInstructions} standing instructions; remove one first.`);
    const item: Instruction = { id: randomUUID(), text: clean, scope, createdAt: this.now().toISOString() };
    this.store.save("settings", this.owner, key, { items: [...items, item] });
    return item;
  }

  remove(id: string): { removed: boolean } {
    const items = this.list();
    this.store.save("settings", this.owner, key, { items: items.filter((item) => item.id !== id) });
    return { removed: items.some((item) => item.id === id) };
  }

  /** A question for the owner; null when the same one was already asked, answered or kept. */
  propose(input: unknown, from: "assistant" | "suggestion"): { waiting: boolean; id?: string } {
    const { text, scope } = InstructionSchema.parse(input);
    const clean = quoteLine(text, 300);
    if (this.list().some((item) => same(item.text) === same(clean) && item.scope === scope)) return { waiting: false };
    const where = scope === "assistant" ? "the assistant" : scope === "everyone" ? "the assistant and every specialist" : `the specialist ${scope.slice(11)}`;
    const entry = this.ledger.ask({ kind: "instruction", from, fingerprint: fingerprintOf("instruction", same(clean), scope),
      title: "Keep this as a standing instruction?", detail: `"${clean}" — for ${where}, in every later task.`, payload: { text: clean, scope } });
    return entry ? { waiting: true, id: entry.id } : { waiting: false };
  }

  /** The instructions that apply to a task, for its system message. */
  forTask(agent: string | undefined, full: boolean): string {
    const apply = this.list().filter((item) => item.scope === "everyone" || (agent ? item.scope === `specialist:${agent}` : item.scope === "assistant"));
    if (!apply.length) return "";
    if (!full) return `The owner has ${apply.length} standing instruction${apply.length === 1 ? "" : "s"} for you; read them with instructions.list before you answer.`;
    return `Standing instructions from the owner (follow them unless the owner says otherwise now):\n${apply.map((item) => `- ${item.text}`).join("\n")}`;
  }
}
