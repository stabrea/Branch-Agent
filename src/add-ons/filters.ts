import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket 15 (A1891): the owner's own filters on what goes in to the model and what comes out.
 *
 * A filter is a small rule, not code: it looks for words (or, for the owner who wants one, a
 * pattern) and then takes them out, stops the message, or adds a note. Filters run in the order of
 * their priority, only for the models they name (all of them when they name none), at the moment a
 * task's words go in ("inlet") and when its answer comes out ("outlet").
 *
 * A filter can only make things stricter. It changes words; it never grants a permission, never
 * turns a tool on, and a message one filter stopped stays stopped whatever a later one says. A
 * filter that came inside an add-on package arrives switched off.
 */
export const filterStages = ["inlet", "outlet", "both"] as const;
export const FilterRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  stage: z.enum(filterStages).default("both"),
  /** Plain words (any of them, ignoring case), or a pattern when `pattern` is true. */
  match: z.string().min(1).max(200),
  pattern: z.boolean().default(false),
  action: z.enum(["redact", "block", "note"]),
  /** What a redacted piece becomes, or the note that is added. */
  text: z.string().trim().max(200).default(""),
  /** Model or connection names this filter is for; empty means every one. */
  models: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  enabled: z.boolean().default(true),
  /** Where it came from: the owner, or the add-on package that brought it. */
  from: z.string().max(80).default("you"),
}).strict();
export type FilterRule = z.infer<typeof FilterRuleSchema>;
export type FilterStage = "inlet" | "outlet";
export interface FilterResult { text: string; blocked: string | null; applied: string[] }

const key = "add-on-filters";
const maxRules = 32, maxText = 200_000;
export const defaultRedaction = "[taken out by your filter]";

/** A pattern whose repeats are nested can take forever on some text; those are refused up front. */
export function unsafePattern(source: string): string | null {
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(source)) return "repeats inside a repeat";
  if (/\\[1-9]/.test(source)) return "refers back to an earlier match";
  try { new RegExp(source, "iu"); } catch { return "is not a pattern this copy can read"; }
  return null;
}

function matcher(rule: FilterRule): RegExp {
  if (rule.pattern) return new RegExp(rule.match, "giu");
  const words = rule.match.split(",").map((word) => word.trim()).filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(words.join("|") || "(?!)", "giu");
}

const applies = (rule: FilterRule, stage: FilterStage, models: readonly string[]): boolean =>
  rule.enabled && (rule.stage === "both" || rule.stage === stage)
  && (!rule.models.length || rule.models.some((name) => models.some((model) => model.toLowerCase() === name.toLowerCase())));

/** Runs the filters over one piece of text. Pure: the same rules and text always give the same answer. */
export function applyFilters(rules: readonly FilterRule[], stage: FilterStage, input: string, models: readonly string[]): FilterResult {
  let text = input;
  const applied: string[] = [];
  const notes: string[] = [];
  const ordered = [...rules].filter((rule) => applies(rule, stage, models)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of ordered) {
    const probe = matcher(rule);
    if (!probe.test(text.slice(0, maxText))) continue;
    applied.push(rule.id);
    if (rule.action === "block") {
      const reason = rule.text || `Your filter "${rule.name}" stopped this ${stage === "inlet" ? "message" : "answer"}.`;
      return { text: "", blocked: reason, applied };
    }
    if (rule.action === "redact") text = text.slice(0, maxText).replace(matcher(rule), rule.text || defaultRedaction) + text.slice(maxText);
    else notes.push(rule.text || `Your filter "${rule.name}" matched this.`);
  }
  return { text: notes.length ? `${text}\n\n${notes.map((note) => `(${note})`).join("\n")}` : text, blocked: null, applied };
}

export class FilterBook {
  constructor(private readonly store: Pick<Store, "get" | "save">, private readonly owner: string) {}
  list(): FilterRule[] {
    const saved = (this.store.get("settings", this.owner, key)?.data as { rules?: unknown[] } | undefined)?.rules ?? [];
    return saved.map((rule) => FilterRuleSchema.safeParse(rule)).filter((r) => r.success).map((r) => r.data);
  }
  private write(rules: FilterRule[]): FilterRule[] {
    if (rules.length > maxRules) throw new Error(`At most ${maxRules} filters.`);
    this.store.save("settings", this.owner, key, { rules });
    return rules;
  }
  /** Adds or replaces one filter by its id. A pattern that could hang is refused. */
  save(input: unknown): FilterRule {
    const rule = FilterRuleSchema.parse(input);
    const problem = rule.pattern ? unsafePattern(rule.match) : null;
    if (problem) throw new Error(`That pattern ${problem}, so it was not saved. Use plain words instead.`);
    this.write([...this.list().filter((kept) => kept.id !== rule.id), rule]);
    return rule;
  }
  remove(id: string): { removed: boolean } {
    const rules = this.list();
    this.write(rules.filter((rule) => rule.id !== id));
    return { removed: rules.some((rule) => rule.id === id) };
  }
  /** Filters an add-on brought: added switched off, never replacing one of the owner's own. */
  adopt(from: string, rules: readonly FilterRule[]): string[] {
    const kept = this.list();
    const taken = new Set(kept.map((rule) => rule.id));
    const added = rules.filter((rule) => !taken.has(rule.id) && !(rule.pattern && unsafePattern(rule.match)))
      .map((rule) => ({ ...rule, enabled: false, from: from.slice(0, 80) }));
    this.write([...kept, ...added]);
    return added.map((rule) => rule.id);
  }
  /** Takes out what an add-on brought, when it is removed. */
  forget(from: string): void { this.write(this.list().filter((rule) => rule.from !== from)); }
  run(stage: FilterStage, text: string, models: readonly string[]): FilterResult {
    const rules = this.list();
    return rules.length ? applyFilters(rules, stage, text, models) : { text, blocked: null, applied: [] };
  }
}
