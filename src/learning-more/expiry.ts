import { z } from "zod";
import { MemoryFacts, visibleTo, type MemoryRecord } from "../memory.js";
import type { Store } from "../store.js";

/**
 * R17-058: facts that stop being kept on a date, and labels (tags) the owner or the assistant puts
 * on a fact, with a search that filters by label and by date. An expired fact is set aside into the
 * memory archive with the note "expired" — its wording is kept as a version and it can be put back
 * from the Memory screen — never deleted. The ideas follow LangGraph's store (item time-to-live,
 * MIT) and classic Letta's archival search with tag and date filters (Apache-2.0); the code is
 * Branch's own. See THIRD_PARTY_NOTICES.md.
 *
 * The labels live on the fact itself (`tags`, `expiresAt` in src/memory.ts). Correcting a fact's
 * words with `memory.update` writes the fact afresh, as it always has (its kind and layer go the
 * same way), so a corrected fact loses its labels and has to be labelled again.
 */
const Tag = z.string().trim().toLowerCase().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, "A label is letters, digits, spaces, dashes");
export const LabelSchema = z.object({
  id: z.string().min(1).max(200),
  tags: z.array(Tag).max(12).optional(),
  /** A moment, or null to keep it for good. */
  expiresAt: z.iso.datetime().nullable().optional(),
  /** Instead of a moment: this many days from now. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
}).strict();
export const FindSchema = z.object({
  query: z.string().max(200).default(""),
  tags: z.array(Tag).max(12).default([]),
  /** Which date the range is about: when the fact was first saved, or last changed. */
  dateField: z.enum(["created", "updated"]).default("created"),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

const dayMs = 86_400_000;
export const isExpired = (record: { data: Record<string, unknown> }, now = Date.now()): boolean => {
  const at = record.data.expiresAt;
  return typeof at === "string" && Date.parse(at) <= now;
};

export class MemoryExpiry {
  private readonly facts: MemoryFacts;
  constructor(private readonly store: Store) { this.facts = new MemoryFacts(store.sqlite); }

  label(owner: string, input: unknown, now = Date.now()): MemoryRecord {
    const value = LabelSchema.parse(input);
    const record = this.facts.get(owner, value.id);
    if (!record) throw new Error("That fact is no longer saved.");
    const data: Record<string, unknown> = { ...record.data };
    if (value.tags) {
      if (value.tags.length) data.tags = [...new Set(value.tags)];
      else delete data.tags;
    }
    const expires = value.expiresInDays ? new Date(now + value.expiresInDays * dayMs).toISOString() : value.expiresAt;
    if (expires === null) delete data.expiresAt;
    else if (expires !== undefined) {
      if (Date.parse(expires) <= now) throw new Error("Choose a moment in the future for it to expire.");
      data.expiresAt = expires;
    }
    return this.facts.save(owner, value.id, data);
  }

  find(owner: string, input: unknown, agent?: string, now = Date.now()) {
    const query = FindSchema.parse(input ?? {});
    const words = query.query.normalize("NFC").toLowerCase().trim();
    const hits = this.facts.list(owner).filter((record) => {
      if (!visibleTo(record, agent) || isExpired(record, now)) return false;
      if (words && !String(record.data.text).normalize("NFC").toLowerCase().includes(words)) return false;
      const tags = new Set((record.data.tags as string[] | undefined) ?? []);
      if (!query.tags.every((tag) => tags.has(tag))) return false;
      const at = query.dateField === "created" ? record.createdAt : record.updatedAt;
      return (!query.from || at >= query.from) && (!query.to || at <= query.to);
    });
    return hits.slice(0, query.limit).map((record) => ({ id: record.id, text: String(record.data.text),
      tags: (record.data.tags as string[] | undefined) ?? [], expiresAt: (record.data.expiresAt as string | undefined) ?? null,
      createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision }));
  }

  /** Every label in use, with how many facts carry it. */
  tags(owner: string): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const record of this.facts.list(owner))
      for (const tag of (record.data.tags as string[] | undefined) ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Sets aside every fact whose moment has come. Safe to call at any time. */
  sweep(owner: string, now = Date.now()): { setAside: string[] } {
    const setAside: string[] = [];
    for (const record of this.facts.list(owner)) {
      if (!isExpired(record, now)) continue;
      this.facts.setAside(owner, record.id, "expired");
      setAside.push(record.id);
    }
    return { setAside };
  }
}

/** The memory snapshot's order, with expired facts left out even before the next sweep. */
export function withoutExpired(records: readonly MemoryRecord[], now = Date.now()): MemoryRecord[] {
  return records.filter((record) => !isExpired(record, now));
}
