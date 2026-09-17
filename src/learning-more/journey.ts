import { z } from "zod";
import { visibleTo, type MemoryRecord } from "../memory.js";
import type { Store } from "../store.js";

/**
 * R17-054: one timeline of what the assistant learned — facts it saved and changed, skills written
 * and revised, suggestions the owner accepted or declined, habits the learning core (src/fly-core)
 * formed, and lessons kept from failed evaluation tasks. It only reads; nothing here changes what
 * is learned. The idea follows Hermes Agent's `/journey` (MIT); see THIRD_PARTY_NOTICES.md.
 */
export const journeyKinds = ["memory", "memory-change", "skill", "decision", "habit", "lesson"] as const;
export type JourneyKind = (typeof journeyKinds)[number];
export const JourneySchema = z.object({
  kinds: z.array(z.enum(journeyKinds)).max(journeyKinds.length).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(300).default(100),
}).strict();
export interface JourneyEntry { at: string; kind: JourneyKind; title: string; detail: string }

const short = (text: unknown, length = 160): string => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const hasTable = (store: Store, name: string): boolean =>
  !!store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

function memories(store: Store, owner: string, agent: string | undefined): JourneyEntry[] {
  return (store.list("memory", owner) as MemoryRecord[]).filter((record) => visibleTo(record, agent))
    .map((record) => ({ at: record.createdAt, kind: "memory" as const, title: "Remembered", detail: short(record.data.text) }));
}

function memoryChanges(store: Store, owner: string, agent: string | undefined): JourneyEntry[] {
  // A specialist's timeline shows only what it may read; earlier wordings are the owner's to see.
  if (agent) return [];
  return store.sqlite.prepare("SELECT data, reason, created_at FROM memory_versions WHERE owner=? ORDER BY created_at DESC LIMIT 300").all(owner)
    .map((row) => ({ at: String(row.created_at), kind: "memory-change" as const,
      title: `Changed a note (${short(row.reason, 60)})`, detail: `It used to say: ${short((JSON.parse(String(row.data)) as { text?: string }).text)}` }));
}

function skills(store: Store, owner: string): JourneyEntry[] {
  const entries: JourneyEntry[] = [];
  for (const skill of store.skills.list(owner))
    for (const version of store.skills.view(owner, skill.id).versions)
      entries.push({ at: version.createdAt, kind: "skill", title: version.version === 1 ? `Learned the skill ${version.name}` : `Revised ${version.name} (version ${version.version})`, detail: short(version.description) });
  return entries;
}

function decisions(store: Store, owner: string): JourneyEntry[] {
  return store.review.proposals(owner, "all").filter((p) => p.status !== "pending" && p.decidedAt)
    .map((p) => ({ at: p.decidedAt!, kind: "decision" as const,
      title: p.status === "accepted" ? `You accepted a ${p.kind} suggestion` : `You declined a ${p.kind} suggestion`, detail: short(p.text) }));
}

function habits(store: Store, owner: string): JourneyEntry[] {
  if (!hasTable(store, "fly_synapses")) return [];
  const names = new Map(store.skills.list(owner).map((skill) => [skill.id, skill.name]));
  return store.sqlite.prepare("SELECT kind, action, uses, net, updated_at FROM fly_synapses WHERE owner=? AND uses>=2 ORDER BY updated_at DESC LIMIT 50").all(owner)
    .map((row) => {
      const kind = String(row.kind), action = String(row.action);
      const name = kind === "skill" ? names.get(action) ?? "a skill" : kind === "memory" ? "a remembered fact" : action;
      const average = Number(row.net) / Math.max(1, Number(row.uses));
      const leaning = average >= 0.3 ? "tended to go well" : average <= -0.3 ? "tended to go badly" : "went both ways";
      return { at: new Date(Number(row.updated_at)).toISOString(), kind: "habit" as const,
        title: `The learning core noticed ${name}`, detail: `Used in ${Number(row.uses)} tasks, which ${leaning}.` };
    });
}

function lessons(store: Store, owner: string): JourneyEntry[] {
  if (!hasTable(store, "lm_lessons")) return [];
  return store.sqlite.prepare("SELECT text, status, updated_at FROM lm_lessons WHERE owner=? AND status<>'trial' ORDER BY updated_at DESC LIMIT 100").all(owner)
    .map((row) => ({ at: String(row.updated_at), kind: "lesson" as const,
      title: String(row.status) === "kept" ? "Kept a lesson that kept paying off" : "Dropped a lesson that did not help", detail: short(row.text) }));
}

export function journey(store: Store, owner: string, input: unknown, agent?: string): { entries: JourneyEntry[]; total: number } {
  const query = JourneySchema.parse(input ?? {});
  const wanted = new Set(query.kinds ?? journeyKinds);
  const sources: [JourneyKind, () => JourneyEntry[]][] = [
    ["memory", () => memories(store, owner, agent)], ["memory-change", () => memoryChanges(store, owner, agent)],
    ["skill", () => (agent ? [] : skills(store, owner))], ["decision", () => (agent ? [] : decisions(store, owner))],
    ["habit", () => (agent ? [] : habits(store, owner))], ["lesson", () => (agent ? [] : lessons(store, owner))],
  ];
  const all = sources.filter(([kind]) => wanted.has(kind)).flatMap(([, read]) => read())
    .filter((entry) => (!query.from || entry.at >= query.from) && (!query.to || entry.at <= query.to))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { entries: all.slice(0, query.limit), total: all.length };
}
