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
  /** Only patches linked to this repository (a Branch project id), matched exactly, never by text or on other kinds. */
  repository?: string | undefined;
}
/**
 * `truncated` is true when the listing stopped at `scanLimit` stored rows while more matching rows
 * were still unread, or wanted more events while the owner has rows older than the `walkLimit`
 * window: then `events` may be missing older genuine events and `rejected` more ids.
 */
export interface CollabListing { events: CollabEvent[]; rejected: string[]; truncated: boolean }

/** The most stored rows one listing looks at before it stops, however many of them fail to verify. */
const scanLimit = 5000;
/**
 * The newest rows of the owner's partition one listing's SQL walks at all: room for `scanLimit` rows
 * to verify and `scanLimit` rows from people outside the household. Every filter (member, kind, text,
 * repository, what the caller may see) runs inside this window, so no request walks further.
 */
const walkLimit = 2 * scanLimit;
/** Who is asking. Only `ownerView: true` is shown the kinds that belong to the owner. */
export interface CollabViewer { ownerView: boolean }

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
 * Kinds whose payload has a fixed shape, each with the one route that publishes it after checking
 * that shape (and anything else, like the repository being real). The general route refuses them,
 * and one received from elsewhere is kept only if its payload has that shape. An `ownerOnly` kind
 * is published through a route only the owner may use, and is listed only to the owner.
 */
export const reservedKinds: ReadonlyMap<string, { payload: z.ZodType; route: string; ownerOnly: boolean }> = new Map([
  [gitPatchKind, { payload: GitPatchSchema, route: "/api/collab/git-patches", ownerOnly: true }],
]);
const ownerOnlyKinds = [...reservedKinds].filter(([, reserved]) => reserved.ownerOnly).map(([kind]) => kind);

export class CollabEvents {
  private root: Promise<Buffer> | undefined;
  constructor(private readonly db: DatabaseSync, private readonly keys: LockerKeySource,
    private readonly members: () => readonly string[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS collab_events(id TEXT PRIMARY KEY, owner TEXT NOT NULL, member TEXT NOT NULL,
      kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS collab_events_owner ON collab_events(owner, at)");
  }
  /** The key for one member: nobody holding only another member's key can sign as them. */
  private async memberKey(member: string): Promise<Buffer> {
    // A key read that fails is not kept: the next call asks again rather than failing until a restart.
    const pending = this.root ??= this.keys.key().then((key) => createHmac("sha256", key).update("branch-collab-events-v1").digest());
    const root = await pending.catch((error: unknown) => { if (this.root === pending) this.root = undefined; throw error; });
    return createHmac("sha256", root).update(member).digest();
  }
  private async signature(event: Omit<CollabEvent, "signature">): Promise<string> {
    const { id, member, kind, at, payload } = event;
    return createHmac("sha256", await this.memberKey(member)).update(canonical({ id, member, kind, at, payload })).digest("hex");
  }
  /** Signs a new event under a member of this household and keeps it. */
  async publish(owner: string, member: string, kind: string, payload: Record<string, unknown>): Promise<CollabEvent> {
    if (!this.members().includes(member)) throw new Error("Only a member of this household can publish an event");
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
    if (!this.members().includes(unsigned.member)) return { valid: false, reason: "The event's member is not in this household" };
    const given = Buffer.from(signature, "hex"), wanted = Buffer.from(await this.signature(unsigned), "hex");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { valid: false, reason: "The signature does not match the event" };
    return { valid: true };
  }
  /**
   * Takes in an event from elsewhere (a relay): kept only when its signature verifies. A patch is
   * kept only when its repository is one of this household's, as on the patch route.
   */
  async receive(owner: string, input: unknown, repositoryExists: (repository: string) => boolean): Promise<CollabEvent> {
    const verdict = await this.verify(input);
    if (!verdict.valid) throw new Error(`Event rejected: ${verdict.reason}`);
    const event = CollabEventSchema.parse(input);
    // A correct signature is not enough for a reserved kind: a patch must look like a patch.
    const reserved = reservedKinds.get(event.kind);
    if (reserved && !reserved.payload.safeParse(event.payload).success) throw new Error(`Event rejected: it is not a valid ${event.kind} event`);
    if (event.kind === gitPatchKind && !repositoryExists(GitPatchSchema.parse(event.payload).repository))
      throw new Error("Event rejected: its repository is not one of this household's");
    if (this.db.prepare("SELECT 1 FROM collab_events WHERE id=?").get(event.id)) throw new Error("Event rejected: it was already received");
    this.insert(owner, event);
    return event;
  }
  /**
   * Newest first, among the newest `walkLimit` rows of the owner's partition. Events that no longer
   * verify are left out and named in `rejected`. Rows whose member is not in the household are skipped
   * in the query itself, so up to `scanLimit` of them (as many as are named in `rejected`) never use up
   * the scan. Owner-only kinds are left out in the query too unless the caller is the owner: they never
   * use up a household person's page or scan, and are not named to them in `rejected` either.
   */
  async list(owner: string, search: CollabSearch = {}, viewer: CollabViewer = { ownerView: false }): Promise<CollabListing> {
    const limit = Math.min(Math.max(Math.trunc(search.limit ?? 100), 1), 500);
    const members = JSON.stringify(this.members()), { from, where, params } = listFilter(owner, search, viewer);
    const page = this.db.prepare(`SELECT * FROM ${from} WHERE ${where}
      AND member IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id LIMIT ? OFFSET ?`);
    const listing: CollabListing = { events: [], rejected: [], truncated: false };
    // Pages are read until `limit` events verify, so rows that no longer verify never use up the page.
    // Bounded: at most `scanLimit` rows are looked at for one listing, and no page reads past it.
    let offset = 0;
    while (listing.events.length < limit && offset < scanLimit) {
      const size = Math.min(limit, scanLimit - offset);
      const rows = page.all(...params, members, size, offset);
      offset += rows.length;
      for (const row of rows) {
        const event = rowEvent(row);
        if (event && (await this.verify(event)).valid) { if (listing.events.length < limit) listing.events.push(event); }
        else listing.rejected.push(String(row.id));
      }
      if (rows.length < size) break;
    }
    // Stopped at the cap with events still wanted: say so when a matching row was left unread.
    if (listing.events.length < limit && offset >= scanLimit) listing.truncated = page.all(...params, members, 1, offset).length > 0;
    const strangers = this.db.prepare(`SELECT id FROM ${from} WHERE ${where}
      AND member NOT IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id LIMIT ?`).all(...params, members, scanLimit + 1);
    if (strangers.length > scanLimit) listing.truncated = true;
    listing.rejected.push(...strangers.slice(0, scanLimit).map((row) => String(row.id)));
    // Events still wanted and rows older than the window: those were never looked at.
    if (listing.events.length < limit && this.db.prepare("SELECT 1 FROM collab_events WHERE owner=? LIMIT 1 OFFSET ?").get(owner, walkLimit))
      listing.truncated = true;
    return listing;
  }
  private insert(owner: string, event: CollabEvent): void {
    this.db.prepare("INSERT INTO collab_events(id, owner, member, kind, at, payload, signature) VALUES(?,?,?,?,?,?,?)")
      .run(event.id, owner, event.member, event.kind, event.at, JSON.stringify(event.payload), event.signature);
  }
}

/**
 * The rows one listing may look at: the owner's newest `walkLimit`, narrowed by the search, with the
 * owner-only kinds taken out for anybody but the owner. `from` binds the owner and the window size.
 */
function listFilter(owner: string, search: CollabSearch, viewer: CollabViewer) {
  const text = search.text ? `%${search.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const repository = search.repository ?? null, hidden = JSON.stringify(viewer.ownerView === true ? [] : ownerOnlyKinds);
  const from = "(SELECT * FROM collab_events WHERE owner=? ORDER BY at DESC, id LIMIT ?)";
  const where = `(? IS NULL OR kind=?) AND (? IS NULL OR payload LIKE ? ESCAPE '\\')
    AND (? IS NULL OR (kind=? AND json_valid(payload) AND json_extract(payload, '$.repository')=?))
    AND kind NOT IN (SELECT value FROM json_each(?))`;
  const params = [owner, walkLimit, search.kind ?? null, search.kind ?? null, text, text, repository, gitPatchKind, repository, hidden];
  return { from, where, params };
}

/** A stored row back as an event, or null when its payload is no longer readable. */
function rowEvent(row: Record<string, unknown>): CollabEvent | null {
  try {
    return { id: String(row.id), member: String(row.member), kind: String(row.kind), at: String(row.at),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>, signature: String(row.signature) };
  } catch { return null; }
}

/**
 * Publishes a patch with its repository's status as one signed event. The repository is a Branch
 * project, and it must be one this household has, so the event cannot point at a made-up one.
 * The repository id sits in the signed payload, so moving an event to another repository breaks it.
 * The project id is the whole identity: a project removed and later made again under the same id is
 * shown the old patches too (only the owner can remove or make projects).
 */
export async function publishGitPatch(events: CollabEvents, owner: string, member: string, input: unknown,
  repositoryExists: (repository: string) => boolean): Promise<CollabEvent> {
  const patch = GitPatchSchema.parse(input);
  if (!repositoryExists(patch.repository)) throw new Error("Repository not found");
  return events.publish(owner, member, gitPatchKind, patch);
}
