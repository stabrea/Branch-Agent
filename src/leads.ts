import { z } from "zod";
import type { ToolDefinition } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Prospect leads: turning a raw list of names and emails into a scored, deduplicated shortlist.
 *
 * Nothing here reaches the network or a paid data provider — every signal comes out of the row the
 * caller already gave (a title, an email, a company). That is enough to say how senior a title
 * reads, whether an email looks like a work address rather than a personal one, and whether the
 * email's domain matches the company named beside it. Two rows that are plainly the same person
 * (the same email, or the same name at the same company) are folded into one before anything is
 * handed back, so a list built from more than one source never double-counts a prospect.
 */

const genericEmailDomains = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "protonmail.com", "live.com", "msn.com", "mail.com",
]);
const executiveWords = ["chief", "ceo", "cfo", "coo", "cto", "cmo", "founder", "president", "owner"];
const seniorWords = ["vp", "vice president", "director", "head of", "senior"];
const midWords = ["manager", "lead"];

export const ProspectInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  company: z.string().trim().max(200).optional(),
  /** Given straight when a caller already knows it; worked out from the email otherwise. */
  domain: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(60).optional(),
  linkedin: z.string().trim().max(300).optional(),
  /** Where this row came from (a list's name, a form, an import), kept so a merged duplicate still says where each half was seen. */
  source: z.string().trim().max(120).optional(),
}).strict();
export type ProspectInput = z.infer<typeof ProspectInputSchema>;

export type Seniority = "executive" | "senior" | "mid" | "unknown";

interface Enrichment {
  domain: string;
  /** True when the email's domain is not one of the free personal providers. */
  workEmail: boolean;
  seniority: Seniority;
}
export interface EnrichedProspect extends Omit<ProspectInput, "domain">, Enrichment {
  score: number;
  /** What two rows are compared by to decide they are the same prospect. */
  dedupeKey: string;
  sources: string[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function domainOfEmail(email?: string): string {
  const at = email?.split("@")[1];
  return at ? at.toLowerCase() : "";
}
function seniorityOf(title?: string): Seniority {
  if (!title) return "unknown";
  const lowered = title.toLowerCase();
  if (executiveWords.some((word) => lowered.includes(word))) return "executive";
  if (seniorWords.some((word) => lowered.includes(word))) return "senior";
  if (midWords.some((word) => lowered.includes(word))) return "mid";
  return "unknown";
}
/** Whether an email's domain reads as the company's own (either name sits inside the other). */
function domainMatchesCompany(domain: string, company?: string): boolean {
  if (!domain || !company) return false;
  const slug = normalize(company).replace(/\s+/g, "");
  const root = domain.split(".")[0] ?? "";
  return slug.length > 2 && root.length > 2 && (root.includes(slug) || slug.includes(root));
}

/** What can be worked out from a raw row without asking anything outside it: its domain, whether its email looks like a work address, and how senior its title reads. */
export function enrichProspect(input: ProspectInput): ProspectInput & Enrichment {
  const domain = (input.domain?.trim().toLowerCase() || domainOfEmail(input.email));
  const workEmail = domain !== "" && !genericEmailDomains.has(domain);
  return { ...input, domain, workEmail, seniority: seniorityOf(input.title) };
}

const seniorityPoints: Record<Seniority, number> = { executive: 40, senior: 28, mid: 14, unknown: 0 };

/**
 * A 0–100 figure from what enrichment found. Seniority carries the most weight (up to 40), a work
 * email at the company's own domain adds up to 35 more, and how much else is filled in (a phone
 * number, a LinkedIn profile, a stated source) adds up to the rest. Nothing here is a guess about
 * the person; it only rewards what the row itself already says.
 */
export function scoreProspect(enriched: ProspectInput & Enrichment): number {
  let score = seniorityPoints[enriched.seniority];
  if (enriched.workEmail) score += 20;
  if (domainMatchesCompany(enriched.domain, enriched.company)) score += 15;
  const extras = [enriched.phone, enriched.linkedin, enriched.title].filter((value) => !!value).length;
  score += Math.min(extras * 5, 15);
  if (enriched.source) score += 10;
  return Math.max(0, Math.min(100, score));
}

/** The steadier of a row's two possible keys: its name at its company (or domain, with no company). Two rows can be the same prospect on this key alone, or on their email (`emailKeyOf`) alone, so a row is matched against a kept one whenever either key is shared. */
export function dedupeKeyOf(input: ProspectInput): string {
  return `name:${normalize(input.name)}|${normalize(input.company ?? input.domain ?? "")}`;
}
/** The other possible key: the email address itself, when one was given. */
export function emailKeyOf(input: ProspectInput): string | null {
  return input.email ? `email:${input.email.trim().toLowerCase()}` : null;
}

export interface LeadsExport {
  leads: EnrichedProspect[];
  totalInput: number;
  duplicatesRemoved: number;
}

/**
 * Enrich, score and de-duplicate a raw prospect set, highest score first. Two rows are the same
 * prospect when EITHER their email matches or their name-and-company key matches — so a row that
 * repeats an earlier email but drops the company, or repeats the name and company but drops the
 * email, is still caught. The higher-scoring row of a pair is kept, and both rows' `source` values
 * are merged onto it, so nothing about where a duplicate was seen is lost even though the row
 * itself is dropped.
 */
export function exportLeads(inputs: readonly ProspectInput[]): LeadsExport {
  const kept: { lead: EnrichedProspect; keys: Set<string> }[] = [];
  for (const raw of inputs) {
    const enriched = enrichProspect(raw);
    const score = scoreProspect(enriched);
    const keys = new Set([dedupeKeyOf(raw), emailKeyOf(raw)].filter((key): key is string => key !== null));
    const sources = raw.source ? [raw.source] : [];
    const match = kept.find((entry) => [...entry.keys].some((key) => keys.has(key)));
    if (!match) {
      kept.push({ lead: { ...enriched, score, dedupeKey: dedupeKeyOf(raw), sources }, keys });
      continue;
    }
    for (const key of keys) match.keys.add(key); // a later row can widen what an earlier one is known by
    const mergedSources = [...new Set([...match.lead.sources, ...sources])];
    match.lead = score > match.lead.score
      ? { ...enriched, score, dedupeKey: match.lead.dedupeKey, sources: mergedSources }
      : { ...match.lead, sources: mergedSources };
  }
  const leads = kept.map((entry) => entry.lead).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { leads, totalInput: inputs.length, duplicatesRemoved: inputs.length - leads.length };
}

export function registerLeads(registry: ToolRegistry): void {
  registry.register(leadsExportTool());
}
function leadsExportTool(): ToolDefinition<{ prospects: ProspectInput[] }> {
  return {
    name: "leads.export", permission: "leads.read",
    description: "Enrich and score a list of sales prospects (title seniority, work-email match, completeness), fold duplicate people into one row, and return the shortlist highest score first.",
    parameters: z.object({ prospects: z.array(ProspectInputSchema).min(1).max(500) }).strict(),
    target: (input) => `${input.prospects.length} prospect${input.prospects.length === 1 ? "" : "s"}`,
    execute: async (input) => exportLeads(input.prospects),
  };
}
