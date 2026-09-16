import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { visibleTo, type MemoryFacts, type MemoryRecord } from "./memory.js";

/**
 * Governance for what the assistant learns: exact versions of every memory, whole-memory
 * checkpoints, staged changes that wait for the owner's acceptance, and a per-conversation
 * memory snapshot that stays stable until the next conversation starts.
 */
export const LearningSettingsSchema = z.object({
  /** After each finished task, ask the model whether anything is worth remembering; suggestions wait for acceptance. */
  review: z.boolean().default(false),
  /** Memory changes the model makes on its own are staged for the owner instead of applied. */
  requireApproval: z.boolean().default(false),
}).strict();
export type LearningSettings = z.infer<typeof LearningSettingsSchema>;
export const ProposalSchema = z.object({
  kind: z.enum(["put", "update", "delete", "skill-note"]),
  memoryId: z.string().max(200).nullable().default(null),
  skillId: z.string().max(200).nullable().default(null),
  text: z.string().trim().max(4000).default(""),
  source: z.string().trim().max(500).default("Suggested after a task"),
  runId: z.string().max(200).default(""),
  note: z.string().max(500).default(""),
}).strict();
export interface Proposal extends z.infer<typeof ProposalSchema> { id: string; status: "pending" | "accepted" | "rejected"; createdAt: string; decidedAt: string | null }
export interface MemoryVersion { memoryId: string; revision: number; data: Record<string, unknown>; reason: string; createdAt: string }
export interface Checkpoint { id: string; label: string; memories: number; skills: number; createdAt: string }
export const memorySnapshotLimits = { facts: 20, chars: 2000 };

export class MemoryReview {
  constructor(private readonly db: DatabaseSync, private readonly memories: MemoryFacts) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_proposals(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS memory_checkpoints(id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, memories TEXT NOT NULL, skills TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  settings(owner: string): LearningSettings {
    const row = this.db.prepare("SELECT data FROM settings WHERE owner=? AND id='learning'").get(owner);
    const parsed = LearningSettingsSchema.safeParse(row ? JSON.parse(String(row.data)) : {});
    return parsed.success ? parsed.data : LearningSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): LearningSettings {
    const value = LearningSettingsSchema.parse(input);
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO settings VALUES('learning',?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
      .run(owner, JSON.stringify(value), now, now);
    return value;
  }
  /** Stages a change for the owner to accept or reject. */
  propose(owner: string, input: unknown): Proposal {
    const data = ProposalSchema.parse(input);
    if (data.kind !== "delete" && data.kind !== "skill-note" && !data.text) throw new Error("A memory suggestion needs text");
    const proposal: Proposal = { ...data, id: randomUUID(), status: "pending", createdAt: new Date().toISOString(), decidedAt: null };
    this.db.prepare("INSERT INTO memory_proposals VALUES(?,?,?,?,?,NULL)").run(proposal.id, owner, JSON.stringify(data), "pending", proposal.createdAt);
    return proposal;
  }
  proposals(owner: string, status: Proposal["status"] | "all" = "pending"): Proposal[] {
    const rows = status === "all"
      ? this.db.prepare("SELECT * FROM memory_proposals WHERE owner=? ORDER BY created_at DESC LIMIT 200").all(owner)
      : this.db.prepare("SELECT * FROM memory_proposals WHERE owner=? AND status=? ORDER BY created_at DESC LIMIT 200").all(owner, status);
    return rows.map((row) => ({ ...ProposalSchema.parse(JSON.parse(String(row.data))), id: String(row.id), status: String(row.status) as Proposal["status"], createdAt: String(row.created_at), decidedAt: row.decided_at === null ? null : String(row.decided_at) }));
  }
  /** Accepting applies the change exactly as staged; rejecting only records the decision. */
  decide(owner: string, id: string, accept: boolean): { proposal: Proposal; applied: unknown } {
    const proposal = this.proposals(owner, "all").find((p) => p.id === id);
    if (!proposal) throw new Error("No such suggestion");
    if (proposal.status !== "pending") throw new Error("That suggestion was already decided");
    let applied: unknown = null;
    if (accept) applied = this.apply(owner, proposal);
    const decidedAt = new Date().toISOString();
    this.db.prepare("UPDATE memory_proposals SET status=?, decided_at=? WHERE id=?").run(accept ? "accepted" : "rejected", decidedAt, id);
    return { proposal: { ...proposal, status: accept ? "accepted" : "rejected", decidedAt }, applied };
  }
  private apply(owner: string, proposal: Proposal): unknown {
    if (proposal.kind === "put") return this.memories.save(owner, randomUUID(), { text: proposal.text, source: proposal.source, sourceRunId: proposal.runId });
    if (proposal.kind === "update") {
      const current = proposal.memoryId ? this.memories.get(owner, proposal.memoryId) : undefined;
      if (!current) throw new Error("The memory this suggestion changes no longer exists");
      return this.memories.save(owner, current.id, { text: proposal.text, source: proposal.source, sourceRunId: proposal.runId });
    }
    if (proposal.kind === "delete") return { removed: proposal.memoryId ? this.memories.delete(owner, proposal.memoryId, `accepted suggestion ${proposal.id}`) : false };
    return { noted: true };
  }
  versions(owner: string, memoryId: string): MemoryVersion[] {
    return this.memories.versions(owner, memoryId);
  }
  /** Writes an earlier version's exact text and source back as a new revision. */
  restoreVersion(owner: string, memoryId: string, revision: number): MemoryRecord {
    const version = this.versions(owner, memoryId).find((v) => v.revision === revision);
    if (!version) throw new Error("That earlier version is not kept");
    const data = version.data as { text: string; source: string; sourceRunId?: string; originRunId?: string };
    return this.memories.save(owner, memoryId, { text: data.text, source: data.source, sourceRunId: data.sourceRunId ?? "" });
  }
  /** Freezes every memory record and every skill's active version so both can be put back exactly. */
  checkpoint(owner: string, input: unknown): Checkpoint {
    const { label } = z.object({ label: z.string().trim().min(1).max(120).default("Checkpoint") }).strict().parse(input ?? {});
    const records = this.memories.list(owner).map((r) => ({ id: r.id, data: r.data, createdAt: r.createdAt, updatedAt: r.updatedAt, revision: r.revision }));
    const skills = this.db.prepare("SELECT id, active_version FROM installed_skills WHERE owner=?").all(owner).map((row) => ({ id: String(row.id), activeVersion: row.active_version === null ? null : Number(row.active_version) }));
    const checkpoint: Checkpoint = { id: randomUUID(), label, memories: records.length, skills: skills.length, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO memory_checkpoints VALUES(?,?,?,?,?,?)").run(checkpoint.id, owner, label, JSON.stringify(records), JSON.stringify(skills), checkpoint.createdAt);
    return checkpoint;
  }
  checkpoints(owner: string): Checkpoint[] {
    return this.db.prepare("SELECT id,label,memories,skills,created_at FROM memory_checkpoints WHERE owner=? ORDER BY created_at DESC LIMIT 50").all(owner)
      .map((row) => ({ id: String(row.id), label: String(row.label), memories: JSON.parse(String(row.memories)).length, skills: JSON.parse(String(row.skills)).length, createdAt: String(row.created_at) }));
  }
  /** Replaces the current memory set with the checkpoint's exact records and re-selects the skill versions it recorded. */
  restoreCheckpoint(owner: string, id: string): { id: string; memories: number; skills: number } {
    const row = this.db.prepare("SELECT * FROM memory_checkpoints WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("That checkpoint is not kept");
    const records = JSON.parse(String(row.memories)) as { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }[];
    const skills = JSON.parse(String(row.skills)) as { id: string; activeVersion: number | null }[];
    this.db.exec("BEGIN");
    try {
      for (const current of this.memories.list(owner)) this.memories.delete(owner, current.id, `before restoring checkpoint ${id}`);
      for (const r of records) this.memories.restoreExact(owner, r);
      let restoredSkills = 0;
      for (const s of skills) restoredSkills += Number(this.db.prepare("UPDATE installed_skills SET active_version=? WHERE owner=? AND id=?").run(s.activeVersion, owner, s.id).changes);
      this.db.exec("COMMIT");
      return { id, memories: records.length, skills: restoredSkills };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** The memory snapshot a conversation started with; the same one is returned for the rest of that conversation. */
  sessionSnapshot(owner: string, sessionId: string, agent?: string): { text: string; count: number; reused: boolean; takenAt: string } {
    const key = `memory-snapshot:${sessionId}`;
    const saved = this.db.prepare("SELECT data FROM settings WHERE owner=? AND id=?").get(owner, key);
    if (saved) return { ...(JSON.parse(String(saved.data)) as { text: string; count: number; takenAt: string }), reused: true };
    const lines: string[] = []; let chars = 0;
    for (const record of this.memories.list(owner).filter((r) => visibleTo(r, agent)).slice(0, memorySnapshotLimits.facts)) {
      const line = `- ${String(record.data.text).replace(/\s+/g, " ").trim()}`;
      if (chars + line.length > memorySnapshotLimits.chars) break;
      lines.push(line); chars += line.length + 1;
    }
    const snapshot = { text: lines.join("\n"), count: lines.length, takenAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO settings VALUES(?,?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data").run(key, owner, JSON.stringify(snapshot), snapshot.takenAt, snapshot.takenAt);
    return { ...snapshot, reused: false };
  }
}
