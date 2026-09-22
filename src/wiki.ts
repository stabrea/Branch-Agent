import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ToolContext, ToolTarget } from "./contracts.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * A small wiki the owner and the assistant write together: pages with names, and links between them
 * written the way people already write them, `[[like this]]`.
 *
 * The point is not storage — memory already keeps facts. The point is that a page can point at
 * another page before that page exists, and start working the moment somebody writes it. So a note
 * about the roof can say "see [[Gutters]]" on a Tuesday and mean something on the Friday.
 *
 * What it refuses, it refuses before writing anything: a page past what a page may hold, an owner
 * past what an owner may keep, a title that would collide with one already there. Nothing is ever
 * half-written.
 *
 * A correction never happens by itself. Writing over a page that exists is an explicit act and must
 * say why; the words that were there are kept, so what a page used to say is never lost silently.
 */

/** At most this many pages belong to one owner. Past this it is a filing system, not a wiki. */
export const maximumPages = 1000;
/** Title and body together, in UTF-8 bytes. A page is something a person reads in one sitting. */
export const maximumPageBytes = 32 * 1024;
/** How many earlier versions of a page are kept. The oldest goes when an eleventh arrives. */
export const maximumHistory = 10;
/** Everything one owner's pages weigh, current and kept versions together. */
export const maximumOwnerBytes = 128 * 1024 * 1024;
/** How many links one read follows, and how far. One hop: a link's page is read, its links are not. */
export const maximumLinksFollowed = 25;
/** How much of a linked page is shown beside the link. */
export const maximumSnippet = 240;

export const WikiWriteSchema = z.object({
  /** What the page is called, as the person writing it chose to spell it. */
  title: z.string().trim().min(1).max(200),
  /**
   * The page itself. `[[Another page]]` anywhere in it is a link.
   *
   * What a page may hold is counted in UTF-8 bytes, by `write()`, which says so in a sentence a
   * person can act on. The number here is only a backstop against something absurd arriving before
   * that check is reached; it is deliberately well above the real limit so the plain refusal is the
   * one people see.
   */
  body: z.string().max(maximumPageBytes * 8),
  /** Why this replaces what was there. Required to write over a page that already exists. */
  why: z.string().trim().min(1).max(500).optional(),
}).strict();
export type WikiWrite = z.infer<typeof WikiWriteSchema>;

export interface WikiPage {
  id: string;
  /** The page's own spelling of its name. */
  title: string;
  body: string;
  /** Why the last write replaced what was there, when it replaced something. */
  why: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface WikiLink {
  /** Exactly what was written between the brackets, trimmed. */
  text: string;
  /** The page's own spelling when the link resolves; otherwise the name as it was written. */
  title: string;
  /** Null until a page by that name exists. */
  pageId: string | null;
  /** The first paragraph of the page it points at, and only when the read was asked to follow. */
  snippet: string | null;
}
export interface WikiReading {
  page: WikiPage;
  links: WikiLink[];
  /** How many links were left unfollowed because the read stops at twenty-five. */
  linksNotFollowed: number;
}

/** One name, reduced to what decides whether two names are the same name. */
export const sameNameAs = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();
/** The first paragraph of a page, short enough to sit beside a link. */
export function firstParagraph(body: string): string {
  const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const oneLine = paragraph.replace(/\s+/g, " ");
  return oneLine.length > maximumSnippet ? `${oneLine.slice(0, maximumSnippet - 1).trimEnd()}…` : oneLine;
}
/** Every `[[link]]` in a page, in the order they are written, each name written only once. */
export function linksIn(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\[\[([^[\]]{1,200})\]\]/g)) {
    const text = match[1]!.trim();
    if (!text || seen.has(sameNameAs(text))) continue;
    seen.add(sameNameAs(text));
    found.push(text);
  }
  return found;
}
const weighs = (title: string, body: string): number => Buffer.byteLength(title, "utf8") + Buffer.byteLength(body, "utf8");

const row = (record: Record<string, unknown>): WikiPage => ({
  id: String(record.id), title: String(record.title), body: String(record.body),
  why: (record.why as string | null) ?? null, version: Number(record.version),
  createdAt: String(record.created_at), updatedAt: String(record.updated_at),
});

export class Wiki {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_pages(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      title TEXT NOT NULL, same_name TEXT NOT NULL, body TEXT NOT NULL, why TEXT,
      bytes INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_name ON wiki_pages(owner, same_name);
      CREATE TABLE IF NOT EXISTS wiki_history(page_id TEXT NOT NULL, owner TEXT NOT NULL,
        version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, why TEXT,
        bytes INTEGER NOT NULL, written_at TEXT NOT NULL, PRIMARY KEY(page_id, version));`);
  }

  /** The page with that name, whatever way it is spelled. */
  find(owner: string, title: string): WikiPage | undefined {
    const record = this.db.prepare("SELECT * FROM wiki_pages WHERE owner=? AND same_name=?")
      .get(owner, sameNameAs(title)) as Record<string, unknown> | undefined;
    return record ? row(record) : undefined;
  }
  page(owner: string, id: string): WikiPage | undefined {
    const record = this.db.prepare("SELECT * FROM wiki_pages WHERE owner=? AND id=?")
      .get(owner, id) as Record<string, unknown> | undefined;
    return record ? row(record) : undefined;
  }
  count(owner: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE owner=?")
      .get(owner) as { n: number }).n);
  }
  /**
   * Everything this owner's pages weigh now, kept versions included. Each row carries its own size,
   * so asking costs a sum over numbers rather than reading every page back out of the database —
   * a refusal that has to happen before a write must be cheap enough to make on every write.
   */
  weight(owner: string): number {
    const of = (table: "wiki_pages" | "wiki_history"): number =>
      Number((this.db.prepare(`SELECT COALESCE(SUM(bytes),0) AS n FROM ${table} WHERE owner=?`)
        .get(owner) as { n: number }).n);
    return of("wiki_pages") + of("wiki_history");
  }

  /**
   * Writes a page. A name nobody has used makes a new page. A name that is already there is a
   * correction, and a correction has to say why: nothing here rewrites a page quietly.
   *
   * Every bound is checked before a single row is written, so a refusal leaves the wiki exactly as
   * it was.
   */
  write(owner: string, input: unknown): { page: WikiPage; replaced: boolean; oldestVersionDropped: number | null } {
    const wanted = WikiWriteSchema.parse(input);
    const existing = this.find(owner, wanted.title);
    // What will actually be stored, weighed. A correction keeps the page's own spelling, so weighing
    // the caller's way of writing the name would measure something that is never written down: a
    // shorter alias could let an oversized page through, a longer one could refuse a page that fits.
    const kept = existing ? existing.title : wanted.title;
    const weight = weighs(kept, wanted.body);
    if (weight > maximumPageBytes)
      throw new Error(`A page holds up to ${maximumPageBytes / 1024} KiB of words; "${kept}" is ${Math.ceil(weight / 1024)} KiB. Split it into two pages.`);

    if (existing && !wanted.why)
      throw new Error(`There is already a page called "${existing.title}". To replace what it says, say why.`);
    if (!existing && this.count(owner) >= maximumPages)
      throw new Error(`The wiki already holds ${maximumPages} pages. Remove one before adding another.`);

    // What the wiki would weigh afterwards. A correction does not take the old words away — they move
    // to the kept versions and sit beside the new ones — but a page that already holds its ten
    // versions lets the oldest one go in the same breath, and those bytes go with it. Counting the
    // write as pure addition would refuse a correction that finishes comfortably inside the bound,
    // and would disagree with what `weight()` says a moment later.
    const letGo = existing ? this.oldestKept(owner, existing.id) : null;
    const after = this.weight(owner) + weight - (letGo?.bytes ?? 0);
    if (after > maximumOwnerBytes)
      throw new Error(`The wiki may hold ${maximumOwnerBytes / 1048576} MB altogether, and this would put it past that. Nothing was written.`);

    const now = new Date().toISOString();
    if (!existing) {
      const page: WikiPage = { id: randomUUID(), title: wanted.title, body: wanted.body,
        why: wanted.why ?? null, version: 1, createdAt: now, updatedAt: now };
      this.db.prepare(`INSERT INTO wiki_pages(id,owner,title,same_name,body,why,bytes,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,?,?)`)
        .run(page.id, owner, page.title, sameNameAs(page.title), page.body, page.why, weight, now, now);
      return { page, replaced: false, oldestVersionDropped: null };
    }

    // A correction. The words that were there are kept first, then replaced, then the oldest kept
    // version goes if there are now more than ten. The page keeps the spelling it was given.
    this.db.exec("BEGIN");
    let dropped: number | null = null;
    try {
      this.db.prepare(`INSERT INTO wiki_history(page_id,owner,version,title,body,why,bytes,written_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(existing.id, owner, existing.version, existing.title, existing.body, existing.why,
          weighs(existing.title, existing.body), existing.updatedAt);
      this.db.prepare("UPDATE wiki_pages SET body=?, why=?, bytes=?, version=?, updated_at=? WHERE owner=? AND id=?")
        .run(wanted.body, wanted.why ?? null, weight, existing.version + 1, now, owner, existing.id);
      // Exactly the row the check above counted on being gone, named before the write rather than
      // looked for again afterwards, so what was promised and what happens cannot drift apart.
      if (letGo) {
        dropped = letGo.version;
        this.db.prepare("DELETE FROM wiki_history WHERE owner=? AND page_id=? AND version=?")
          .run(owner, existing.id, dropped);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { page: this.page(owner, existing.id)!, replaced: true, oldestVersionDropped: dropped };
  }

  /**
   * The kept version this page would let go of if it were corrected now — that is, only once it is
   * already holding its ten. Null when there is still room, because then nothing is let go.
   */
  private oldestKept(owner: string, pageId: string): { version: number; bytes: number } | null {
    const kept = this.db.prepare("SELECT version, bytes FROM wiki_history WHERE owner=? AND page_id=? ORDER BY version ASC")
      .all(owner, pageId) as { version: number; bytes: number }[];
    if (kept.length < maximumHistory) return null;
    return { version: Number(kept[0]!.version), bytes: Number(kept[0]!.bytes) };
  }

  /** What a page used to say, newest first, at most ten of them. */
  history(owner: string, id: string): { version: number; title: string; body: string; why: string | null; writtenAt: string }[] {
    return (this.db.prepare("SELECT * FROM wiki_history WHERE owner=? AND page_id=? ORDER BY version DESC LIMIT ?")
      .all(owner, id, maximumHistory) as Record<string, unknown>[])
      .map((one) => ({ version: Number(one.version), title: String(one.title), body: String(one.body),
        why: (one.why as string | null) ?? null, writtenAt: String(one.written_at) }));
  }

  /**
   * Reads a page and says what its links point at. With `follow`, each link that resolves brings back
   * the first paragraph of the page it names — one hop only, so a page that links back to this one
   * does not send the read round again.
   */
  read(owner: string, title: string, options: { follow?: boolean } = {}): WikiReading {
    const page = this.find(owner, title);
    if (!page) throw new Error(`There is no page called "${title.trim()}" yet.`);
    const names = linksIn(page.body);
    const links = names.slice(0, maximumLinksFollowed).map((text) => {
      const to = this.find(owner, text);
      return {
        text,
        title: to?.title ?? text,
        pageId: to?.id ?? null,
        snippet: options.follow && to ? firstParagraph(to.body) : null,
      };
    });
    return { page, links, linksNotFollowed: Math.max(0, names.length - maximumLinksFollowed) };
  }

  /** Pages whose name or words hold what was asked for. */
  search(owner: string, query: string, limit = 20): { id: string; title: string; snippet: string }[] {
    const like = `%${query.trim().toLowerCase()}%`;
    return (this.db.prepare(`SELECT id, title, body FROM wiki_pages WHERE owner=?
        AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?) ORDER BY updated_at DESC LIMIT ?`)
      .all(owner, like, like, Math.min(limit, 50)) as Record<string, unknown>[])
      .map((one) => ({ id: String(one.id), title: String(one.title), snippet: firstParagraph(String(one.body)) }));
  }

  /** Pages that link to this one, by name. */
  linkingTo(owner: string, title: string): { id: string; title: string }[] {
    const name = sameNameAs(title);
    return (this.db.prepare("SELECT id, title, body FROM wiki_pages WHERE owner=?").all(owner) as Record<string, unknown>[])
      .filter((one) => linksIn(String(one.body)).some((text) => sameNameAs(text) === name))
      .map((one) => ({ id: String(one.id), title: String(one.title) }));
  }

  remove(owner: string, title: string): { removed: string } {
    const page = this.find(owner, title);
    if (!page) throw new Error(`There is no page called "${title.trim()}".`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM wiki_history WHERE owner=? AND page_id=?").run(owner, page.id);
      this.db.prepare("DELETE FROM wiki_pages WHERE owner=? AND id=?").run(owner, page.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { removed: page.title };
  }
}

/**
 * What a call to the wiki touches, in a shape the owner's rules can judge. A page is named like a
 * path — `wiki/Roof repairs` — so a rule written about `wiki/**` or about one page holds, and a
 * search says plainly that it reaches the whole wiki rather than one page.
 */
const pageTarget = (kind: ToolTarget["kind"], title: string): ToolTarget[] =>
  [{ kind, path: `wiki/${sameNameAs(title)}` }];
const wholeWiki = (): ToolTarget[] => [{ kind: "read", path: "wiki", folder: true }];
/**
 * What a read really touches. Without `follow` that is one page. With it, the answer carries a piece
 * of every page the links resolve to, so every one of those is named here — before the rules are
 * consulted, not after. A rule that refuses one page must refuse a read that would hand back a piece
 * of it through a link on another.
 */
function readTargets(wiki: Wiki, owner: string, title: string, follow: boolean): ToolTarget[] {
  const start = pageTarget("read", title);
  if (!follow) return start;
  const page = wiki.find(owner, title);
  if (!page) return start;
  const reached = linksIn(page.body).slice(0, maximumLinksFollowed)
    .map((text) => wiki.find(owner, text))
    .filter((one): one is WikiPage => Boolean(one))
    .map((one) => ({ kind: "read" as const, path: `wiki/${sameNameAs(one.title)}` }));
  return [...start, ...reached];
}

export const shortLivedWikiRefusal = "A short-lived key cannot read or write the wiki. Do that in the app window.";
export const chatWikiRefusal = "A message from a chat app cannot read or write the wiki. Do that in the app window.";
/**
 * The wiki belongs to the owner wherever it is reached from, not only over HTTP. A tool runs inside a
 * task, and a task can have been started by somebody else at this computer, by a short-lived key or by
 * a message from a chat app; the route guard never sees any of those. So the same check sits at the
 * top of every wiki tool as well.
 */
export const householdWikiRefusal = "The wiki belongs to the owner. Switch back to the owner's profile to use it.";
/**
 * Whether this call is the owner's own, and if not, why not — one answer, used by both the guard that
 * refuses a tool and the step that works out what a call would touch.
 *
 * **A task decides for itself.** When there is a real run behind the call, the answer comes from what
 * that run wrote down when it started: whose it is, whether a short-lived key asked for it, whether a
 * chat message started it. The profile showing in the window is deliberately not consulted then, and
 * that is the whole point: the owner's own task keeps being the owner's while they look at somebody
 * else's profile, and a household person's task stays theirs after the window is switched back.
 *
 * Reading the window instead would be wrong in both directions. It would refuse an owner's task for the
 * wrong reason — which, in the step that works out targets, quietly drops the pages a read would reach
 * and lets a refused page through. And it would let a household task in once the window changed.
 *
 * With no run behind the call at all — somebody working the tool by hand — there is nothing to read, so
 * the window is what decides, exactly as it does everywhere else.
 */
function notTheOwners(store: Store, context: ToolContext): string | null {
  // A real task is one that wrote down where it came from when it started. A bare run row with no
  // `run.started` recorded nothing about whose it is, so there is nothing to read and the window
  // decides, the same as a call made by hand.
  const started = Boolean(context.runId) && store.run(context.runId!) !== undefined
    && store.events(context.runId!).some((event) => event.kind === "run.started");
  if (started) {
    const origin = runOrigin(store, context.runId!);
    if (origin.personProfileId) return householdWikiRefusal;
    if (origin.shortLivedKey || startedWithShortLivedKey()) return shortLivedWikiRefusal;
    if (origin.source === "channel" || context.source === "channel") return chatWikiRefusal;
    return null;
  }
  try { store.profiles.requireOwner("The wiki"); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (startedWithShortLivedKey()) return shortLivedWikiRefusal;
  if (startedFromChat(context, store)) return chatWikiRefusal;
  return null;
}
function onlyTheOwner(store: Store, context: ToolContext): void {
  const refusal = notTheOwners(store, context);
  if (refusal) throw new Error(refusal);
}
/**
 * The same question, asked without throwing, for the one place that runs **before** a tool does: working
 * out what a call would touch. That step reads the owner's page to resolve its links, so for anybody but
 * the owner it must not run at all — otherwise a refusal could name a page they were never allowed to
 * know the name of, and the refusal would be the leak.
 */
function ownerIsAsking(store: Store, context: ToolContext): boolean {
  return notTheOwners(store, context) === null;
}

export function registerWiki(registry: ToolRegistry, wiki: Wiki, owner: string, store: Store): void {
  registry.register({
    name: "wiki.read", group: "memory", permission: "memory.read",
    description: "Read one page of the wiki, and what its [[links]] point at.",
    parameters: z.object({
      title: z.string().trim().min(1).max(200),
      /** Bring back the first paragraph of each page linked from this one. One hop, never further. */
      follow: z.boolean().default(false),
    }).strict(),
    target: (input) => `wiki/${sameNameAs(input.title)}`,
    // Only the owner's own call gets the precise answer, because working it out reads their pages.
    // For anybody else the call names the page they asked for and nothing else — which is their own
    // words back — and the guard inside the tool refuses them a moment later anyway.
    targets: (input, context) => ownerIsAsking(store, context)
      ? readTargets(wiki, owner, input.title, input.follow)
      : pageTarget("read", input.title),
    execute: async (input, context) => {
      onlyTheOwner(store, context);
      return wiki.read(owner, input.title, { follow: input.follow });
    },
  });
  registry.register({
    name: "wiki.write", group: "memory", permission: "memory.write",
    description: "Write a page of the wiki. Writing over a page that already exists needs a reason.",
    parameters: WikiWriteSchema,
    target: (input) => `wiki/${sameNameAs(input.title)}`,
    targets: (input) => pageTarget("write", input.title),
    execute: async (input, context) => {
      onlyTheOwner(store, context);
      return wiki.write(owner, input);
    },
  });
  registry.register({
    name: "wiki.search", group: "memory", permission: "memory.read",
    description: "Find pages of the wiki whose name or words hold what was asked for.",
    parameters: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    target: () => "wiki",
    targets: () => wholeWiki(),
    execute: async (input, context) => {
      onlyTheOwner(store, context);
      return { pages: wiki.search(owner, input.query, input.limit) };
    },
  });
  registry.register({
    name: "wiki.history", group: "memory", permission: "memory.read",
    description: "What a page of the wiki used to say, newest first.",
    parameters: z.object({ title: z.string().trim().min(1).max(200) }).strict(),
    target: (input) => `wiki/${sameNameAs(input.title)}`,
    targets: (input) => pageTarget("read", input.title),
    execute: async (input, context) => {
      onlyTheOwner(store, context);
      const page = wiki.find(owner, input.title);
      if (!page) throw new Error(`There is no page called "${input.title.trim()}".`);
      return { page: { id: page.id, title: page.title, version: page.version }, earlier: wiki.history(owner, page.id) };
    },
  });
}

/** What the wiki's routes need: the pages, and who is at the window. */
export interface WikiApiParts {
  wiki: Wiki;
  owner: string;
  profiles: { requireOwner(why: string): void };
}
/** Every path this file answers, so the main route file can hand them over in one line. */
export const handlesWikiPath = (path: string): boolean => /^\/api\/wiki(\/|$)/.test(path);
/**
 * The wiki's routes. The owner check is the first thing here, so it moves with the operation in a
 * refactor and holds for a caller that found another way in — the same practice as handing back an
 * attached file. Returns null for a path that is not one of these.
 */
export async function wikiApi(
  parts: WikiApiParts, request: { method?: string | undefined }, path: string, body: () => Promise<unknown>,
  search: URLSearchParams,
): Promise<unknown | null> {
  parts.profiles.requireOwner("The wiki");
  const method = request.method ?? "GET";
  const { wiki, owner } = parts;
  if (path === "/api/wiki") {
    if (method === "GET") return { pages: wiki.search(owner, search.get("q") ?? "", 50), count: wiki.count(owner) };
    if (method === "POST") return wiki.write(owner, await body());
    return null;
  }
  if (path === "/api/wiki/page" && method === "GET") {
    const title = search.get("title") ?? "";
    return wiki.read(owner, title, { follow: search.get("follow") === "1" });
  }
  if (path === "/api/wiki/history" && method === "GET") {
    const page = wiki.find(owner, search.get("title") ?? "");
    if (!page) throw new Error(`There is no page called "${(search.get("title") ?? "").trim()}".`);
    return { page: { id: page.id, title: page.title, version: page.version }, earlier: wiki.history(owner, page.id) };
  }
  if (path === "/api/wiki/page" && method === "DELETE") return wiki.remove(owner, search.get("title") ?? "");
  return null;
}
