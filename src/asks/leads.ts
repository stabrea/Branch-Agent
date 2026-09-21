import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { requireAsk } from "./settings.js";

/**
 * A list of prospects, made useful: each one filled out from what it already says, scored against
 * what the owner is looking for, and handed back as a CSV with duplicates taken out.
 *
 *   - Filling out is worked out from the fields themselves, on this computer: the company's web
 *     domain from an email address or a website, the company name tidied, how senior the job title
 *     sounds. Nothing is looked up online and nobody is contacted; a field that cannot be worked out
 *     stays empty rather than guessed.
 *   - Scoring counts the owner's own words (the kind of company, the titles, the places that matter)
 *     and says, for each prospect, which of them matched, so a score can always be checked.
 *   - Duplicates are the same email address, or the same person at the same company domain; the one
 *     with the most filled-in fields is kept and the others are named as dropped.
 * Prospects are other people's details, so they are kept in the owner's own database and nowhere
 * else, and the list is emptied with one call.
 */
export const ProspectSchema = z.object({
  name: z.string().trim().max(160).default(""),
  email: z.string().trim().max(254).default(""),
  company: z.string().trim().max(160).default(""),
  title: z.string().trim().max(160).default(""),
  website: z.string().trim().max(300).default(""),
  location: z.string().trim().max(160).default(""),
  notes: z.string().trim().max(1000).default(""),
}).strict();
export type ProspectInput = z.input<typeof ProspectSchema>;

export const CriteriaSchema = z.object({
  /** Words about the company or its notes: "logistics", "SaaS". Each match is worth 2. */
  company: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /** Words in the job title: "operations", "founder". Each match is worth 3. */
  titles: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /** Places that count: "Atlanta", "Georgia". A match is worth 2. */
  locations: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
}).strict();
export type Criteria = z.infer<typeof CriteriaSchema>;

export interface Lead extends z.infer<typeof ProspectSchema> {
  id: string; domain: string; seniority: "leader" | "manager" | "individual" | ""; score: number; matched: string[];
}

const freeMail = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);

/** The company's domain from an email address (not a free mail service) or a website, or "". */
export function domainOf(email: string, website: string): string {
  const fromMail = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(email.trim())?.[1]?.toLowerCase() ?? "";
  if (fromMail && !freeMail.has(fromMail)) return fromMail;
  const site = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i.exec(website.trim())?.[1]?.toLowerCase() ?? "";
  return site;
}

/** How senior a job title sounds, from its words alone. */
export function seniorityOf(title: string): Lead["seniority"] {
  const words = title.toLowerCase();
  if (!words.trim()) return "";
  if (/\b(founder|co-?founder|owner|ceo|cto|cfo|coo|chief|president|vp|vice president|partner|director|head)\b/.test(words)) return "leader";
  if (/\b(manager|lead|principal|supervisor)\b/.test(words)) return "manager";
  return "individual";
}

const tidyCompany = (company: string): string => company.replace(/\s+/g, " ").replace(/[,.]?\s*\b(inc|llc|ltd|gmbh|corp|co)\.?$/i, "").trim();
const includesWord = (text: string, word: string): boolean => text.toLowerCase().includes(word.toLowerCase());

/** One prospect filled out and scored; every point comes with the word that earned it. */
export function enrich(input: ProspectInput, criteria: Criteria): Omit<Lead, "id"> {
  const p = ProspectSchema.parse(input);
  const domain = domainOf(p.email, p.website);
  const seniority = seniorityOf(p.title);
  const matched: string[] = [];
  let score = 0;
  for (const word of criteria.company) if (includesWord(`${p.company} ${p.notes} ${domain}`, word)) { score += 2; matched.push(`company: ${word}`); }
  for (const word of criteria.titles) if (includesWord(p.title, word)) { score += 3; matched.push(`title: ${word}`); }
  for (const word of criteria.locations) if (includesWord(p.location, word)) { score += 2; matched.push(`location: ${word}`); }
  if (seniority === "leader") { score += 2; matched.push("seniority: leader"); }
  if (p.email) { score += 1; matched.push("has an email address"); }
  return { ...p, company: tidyCompany(p.company), domain, seniority, score, matched };
}

const filled = (lead: Omit<Lead, "id" | "score" | "matched">): number =>
  ["name", "email", "company", "title", "website", "location", "notes", "domain"].filter((key) => String(lead[key as keyof typeof lead] ?? "").trim()).length;

/**
 * Duplicates out: the same email, or the same name at the same domain. Within a new batch the fullest
 * record stays; one already kept always stays, since it is already on the owner's list.
 */
export function dedupe<T extends Omit<Lead, "id" | "score" | "matched">>(leads: readonly T[], alreadyKept: readonly T[] = []): { kept: T[]; dropped: { kept: T; dropped: T }[] } {
  const keyOf = (lead: T): string[] => [
    lead.email ? `email:${lead.email.toLowerCase()}` : "",
    lead.name && lead.domain ? `person:${lead.name.toLowerCase().replace(/\s+/g, " ")}@${lead.domain}` : "",
  ].filter(Boolean);
  const kept: T[] = [...alreadyKept];
  const dropped: { kept: T; dropped: T }[] = [];
  for (const lead of [...leads].sort((a, b) => filled(b) - filled(a))) {
    const same = kept.find((other) => keyOf(other).some((key) => keyOf(lead).includes(key)));
    if (same) dropped.push({ kept: same, dropped: lead }); else kept.push(lead);
  }
  return { kept: kept.slice(alreadyKept.length), dropped };
}

const csvCell = (value: unknown): string => {
  const text = String(value ?? "");
  // A cell that starts like a formula is opened as text, so a spreadsheet never runs it.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const columns = ["name", "email", "company", "title", "domain", "seniority", "location", "score", "matched"] as const;

export function leadsCsv(leads: readonly Lead[]): string {
  return [columns.join(","), ...leads.map((lead) => columns.map((column) =>
    csvCell(column === "matched" ? lead.matched.join("; ") : lead[column])).join(","))].join("\n") + "\n";
}

export class Leads {
  constructor(private readonly store: Store, private readonly owner: string) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS asks_leads(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }

  /** Fills out and scores a batch, drops duplicates (within the batch and against what is kept), and keeps the rest. */
  add(prospects: unknown, criteria: unknown): { added: Lead[]; dropped: { kept: string; dropped: string }[] } {
    const list = z.array(ProspectSchema).min(1).max(500).parse(prospects);
    const wanted = CriteriaSchema.parse(criteria ?? {});
    const existing = this.list();
    const fresh = list.map((one) => ({ ...enrich(one, wanted), id: randomUUID() }));
    const { kept: added, dropped } = dedupe<Lead>(fresh, existing);
    const insert = this.store.sqlite.prepare("INSERT INTO asks_leads(id, owner, data, created_at) VALUES (?, ?, ?, ?)");
    const at = new Date().toISOString();
    for (const lead of added) insert.run(lead.id, this.owner, JSON.stringify(lead), at);
    const said = (lead: Lead) => lead.email || `${lead.name} (${lead.domain || lead.company || "no company"})`;
    return { added, dropped: dropped.map((pair) => ({ kept: said(pair.kept), dropped: said(pair.dropped) })) };
  }

  /** Best first. */
  list(): Lead[] {
    return (this.store.sqlite.prepare("SELECT data FROM asks_leads WHERE owner=?").all(this.owner) as { data: string }[])
      .map((row) => JSON.parse(row.data) as Lead).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  export(): { csv: string; count: number } { const all = this.list(); return { csv: leadsCsv(all), count: all.length }; }

  clear(): number { return Number(this.store.sqlite.prepare("DELETE FROM asks_leads WHERE owner=?").run(this.owner).changes); }
}

const AddSchema = z.object({ prospects: z.array(ProspectSchema).min(1).max(500), criteria: CriteriaSchema.optional() }).strict();
type AddInput = z.infer<typeof AddSchema>;

export function registerLeads(registry: ToolRegistry, store: Store, owner: string, leads: Leads): void {
  const guard = () => requireAsk(store, owner, "leads");
  registry.register({
    name: "leads.add", permission: "leads.write",
    description: "Add prospects: each is filled out from its own fields (domain, tidy company, seniority), scored against the owner's words, and duplicates are dropped and named.",
    parameters: AddSchema,
    target: (input: AddInput) => `${input.prospects.length} prospects`,
    execute: async (input: AddInput) => { guard(); return leads.add(input.prospects, input.criteria); },
  });
  registry.register({
    name: "leads.export", permission: "leads.read",
    description: "The kept prospects, best score first, as CSV with the words each score came from. Duplicates are already out.",
    parameters: z.object({}).strict(),
    target: () => "your prospect list",
    execute: async () => { guard(); return leads.export(); },
  });
  registry.register({
    name: "leads.clear", permission: "leads.write",
    description: "Empty the prospect list.",
    parameters: z.object({}).strict(),
    target: () => "your prospect list",
    execute: async () => { guard(); return { removed: leads.clear() }; },
  });
}
