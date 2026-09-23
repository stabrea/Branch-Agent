import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { projectIdSchema, type LockerKeySource } from "./locker.js";
import { canonical } from "./receipts.js";

/**
 * Collaboration events: short notes one member of the household publishes for the others. Each
 * event is signed under the member who published it, the same way tool receipts are signed: an
 * HMAC over a canonical form with a key derived from the device's locker key. Every member gets
 * their own key (the locker key, then "branch-collab-events-v1", then their member id), so a
 * signature made under one member does not pass for another. There are no per-member keypairs
 * in the app yet, so this proves who published an event on this device; it is not a public-key
 * signature another computer could check without the locker key.
 * An event whose member, kind, time or payload changed after signing is rejected when it is
 * received and left out when events are listed; it is never shown as genuine.
 */
export const ownerMember = "owner";
export const collabKindSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,39}$/, "Event kinds use lowercase letters, digits, dots and dashes");
export const collabPayloadSchema = z.record(z.string(), z.unknown())
  .refine((value) => canonical(value).length <= 65536, "An event payload may be at most 64 KB");
export const CollabEventSchema = z.object({
  id: z.string().uuid(), member: z.string().min(1).max(64), kind: collabKindSchema,
  at: z.string().min(1).max(40), payload: collabPayloadSchema, signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CollabEvent = z.infer<typeof CollabEventSchema>;
export type CollabVerdict = { valid: true } | { valid: false; reason: string };
export interface CollabSearch {
  kind?: string | undefined; text?: string | undefined; limit?: number | undefined;
  /** Only events linked to this repository (a Branch project id), matched exactly, never by text. */
  repository?: string | undefined;
}
export interface CollabListing { events: CollabEvent[]; rejected: string[] }

export class CollabEvents {
  private root: Promise<Buffer> | undefined;
  constructor(private readonly db: DatabaseSync, private readonly keys: LockerKeySource,
    private readonly isMember: (member: string) => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS collab_events(id TEXT PRIMARY KEY, owner TEXT NOT NULL, member TEXT NOT NULL,
      kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS collab_events_owner ON collab_events(owner, at)");
  }
  /** The key for one member: nobody holding only another member's key can sign as them. */
  private async memberKey(member: string): Promise<Buffer> {
    const root = await (this.root ??= this.keys.key().then((key) => createHmac("sha256", key).update("branch-collab-events-v1").digest()));
    return createHmac("sha256", root).update(member).digest();
  }
  private async signature(event: Omit<CollabEvent, "signature">): Promise<string> {
    const { id, member, kind, at, payload } = event;
    return createHmac("sha256", await this.memberKey(member)).update(canonical({ id, member, kind, at, payload })).digest("hex");
  }
  /** Signs a new event under a member of this household and keeps it. */
  async publish(owner: string, member: string, kind: string, payload: Record<string, unknown>): Promise<CollabEvent> {
    if (!this.isMember(member)) throw new Error("Only a member of this household can publish an event");
    const unsigned = { id: randomUUID(), member, kind: collabKindSchema.parse(kind),
      // Round-tripped through JSON first, so what is signed is exactly what is stored and read back.
      at: new Date().toISOString(), payload: collabPayloadSchema.parse(JSON.parse(JSON.stringify(payload))) };
    const event = { ...unsigned, signature: await this.signature(unsigned) };
    this.insert(owner, event);
    return event;
  }
  /** Checks that an event is exactly what its member signed. */
  async verify(input: unknown): Promise<CollabVerdict> {
    const parsed = CollabEventSchema.safeParse(input);
    if (!parsed.success) return { valid: false, reason: "The event is not in the expected shape" };
    const { signature, ...unsigned } = parsed.data;
    if (!this.isMember(unsigned.member)) return { valid: false, reason: "The event's member is not in this household" };
    const given = Buffer.from(signature, "hex"), wanted = Buffer.from(await this.signature(unsigned), "hex");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { valid: false, reason: "The signature does not match the event" };
    return { valid: true };
  }
  /** Takes in an event from elsewhere (a relay): kept only when its signature verifies. */
  async receive(owner: string, input: unknown): Promise<CollabEvent> {
    const verdict = await this.verify(input);
    if (!verdict.valid) throw new Error(`Event rejected: ${verdict.reason}`);
    const event = CollabEventSchema.parse(input);
    if (this.db.prepare("SELECT 1 FROM collab_events WHERE id=?").get(event.id)) throw new Error("Event rejected: it was already received");
    this.insert(owner, event);
    return event;
  }
  /** Newest first. Events that no longer verify are left out and named in `rejected`. */
  async list(owner: string, search: CollabSearch = {}): Promise<CollabListing> {
    const limit = Math.min(Math.max(Math.trunc(search.limit ?? 100), 1), 500);
    const text = search.text ? `%${search.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const repository = search.repository ?? null;
    const rows = this.db.prepare(`SELECT * FROM collab_events WHERE owner=? AND (? IS NULL OR kind=?)
      AND (? IS NULL OR payload LIKE ? ESCAPE '\\')
      AND (? IS NULL OR json_extract(payload, '$.repository')=?) ORDER BY at DESC, id LIMIT ?`)
      .all(owner, search.kind ?? null, search.kind ?? null, text, text, repository, repository, limit);
    const listing: CollabListing = { events: [], rejected: [] };
    for (const row of rows) {
      const event = rowEvent(row);
      if (event && (await this.verify(event)).valid) listing.events.push(event);
      else listing.rejected.push(String(row.id));
    }
    return listing;
  }
  private insert(owner: string, event: CollabEvent): void {
    this.db.prepare("INSERT INTO collab_events(id, owner, member, kind, at, payload, signature) VALUES(?,?,?,?,?,?,?)")
      .run(event.id, owner, event.member, event.kind, event.at, JSON.stringify(event.payload), event.signature);
  }
}

/** A stored row back as an event, or null when its payload is no longer readable. */
function rowEvent(row: Record<string, unknown>): CollabEvent | null {
  try {
    return { id: String(row.id), member: String(row.member), kind: String(row.kind), at: String(row.at),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>, signature: String(row.signature) };
  } catch { return null; }
}

/** What a repository looked like when a patch was published: its branch, head commit and changed files. */
export const GitStatusSchema = z.object({
  branch: z.string().min(1).max(200), head: z.string().regex(/^[a-f0-9]{40}$/, "A head is a full 40-character commit id"),
  clean: z.boolean(), changed: z.array(z.string().min(1).max(500)).max(500),
}).strict();
export const GitPatchSchema = z.object({
  repository: projectIdSchema, title: z.string().trim().min(1).max(200),
  patch: z.string().min(1).max(60000), status: GitStatusSchema,
}).strict();
export const gitPatchKind = "git.patch";

/**
 * Publishes a patch with its repository's status as one signed event. The repository is a Branch
 * project, and it must be one this household has, so the event cannot point at a made-up one.
 * The repository id sits in the signed payload, so moving an event to another repository breaks it.
 */
export async function publishGitPatch(events: CollabEvents, owner: string, member: string, input: unknown,
  repositoryExists: (repository: string) => boolean): Promise<CollabEvent> {
  const patch = GitPatchSchema.parse(input);
  if (!repositoryExists(patch.repository)) throw new Error("Repository not found");
  return events.publish(owner, member, gitPatchKind, patch);
}
