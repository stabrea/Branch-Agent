import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { detectInjection } from "./content-guard.js";
import type { RetrievedPassage, Retriever } from "./retrieval.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * A small personal wiki: pages the owner (or the assistant, on their behalf) writes down, that
 * link to each other with `[[Another Page]]`. Unlike a knowledge base, nothing here is read from a
 * file — a page is only ever written by a `wiki.write` call, so what it says is exactly what was
 * typed, never a guess at what a document meant.
 *
 * The point of linking pages is that answering one question can pull in what a *related* page
 * says, not only the page that happened to match the words asked. `follow()` does that: one hop
 * out from whichever page matched, along the links the pages themselves declare.
 *
 * The second half of the job is a correction. When the owner puts a page right — "no, the office
 * key is with Priya, not Dan" — that correction has to survive everything that happens to the page
 * afterwards: the page being read again, a further edit to its body, another page linking to it.
 * A correction is therefore kept in a column of its own, never folded into the body text, and
 * `render()` — the one place a page's words are ever handed back — always puts it in front.
 */
export const maximumLinksPerPage = 40;
export const maximumTitleLength = 200;
export const maximumBodyLength = 20000;
export const maximumCorrectionLength = 2000;
export const linkPattern = /\[\[([^[\]]{1,200})\]\]/g;

export const WriteSchema = z.object({
  space: z.string().trim().min(1).max(120).default("default"),
  title: z.string().trim().min(1).max(maximumTitleLength),
  body: z.string().trim().min(1).max(maximumBodyLength),
}).strict();
export const CorrectSchema = z.object({
  space: z.string().trim().min(1).max(120).default("default"),
  title: z.string().trim().min(1).max(maximumTitleLength),
  correction: z.string().trim().min(1).max(maximumCorrectionLength),
}).strict();
export const ViewSchema = z.object({
  space: z.string().trim().min(1).max(120).default("default"),
  title: z.string().trim().min(1).max(maximumTitleLength),
}).strict();
export const FollowSchema = z.object({
  space: z.string().trim().min(1).max(120).default("default"),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

export interface WikiPage {
  space: string; slug: string; title: string; body: string;
  correction: string; correctedAt: string | null;
  revision: number; createdAt: string; updatedAt: string;
}
export interface WikiPageView extends WikiPage {
  links: { slug: string; title: string; exists: boolean }[];
  backlinks: { slug: string; title: string }[];
}

/** How a page reads once its links have been named and its correction (if any) put in front. */
export function render(page: WikiPage): string {
  const corrected = page.correction
    ? `Correction from the owner (this supersedes anything below that disagrees with it): ${page.correction}\n\n`
    : "";
  return `${corrected}# ${page.title}\n\n${page.body}`;
}
/** The same words used everywhere a title becomes a key, so "Dan's Office" and "dans office" are one page. */
export const slugOf = (title: string): string =>
  title.toLowerCase().trim().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "page";
/** The titles a page's body links to, in the order they first appear, each one kept once. */
export function linksIn(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(linkPattern)) {
    const title = match[1]!.trim();
    const slug = slugOf(title);
    if (!title || seen.has(slug)) continue;
    seen.add(slug);
    found.push(title);
    if (found.length >= maximumLinksPerPage) break;
  }
  return found;
}

export class WikiPages {
  private readonly db: DatabaseSync;
  constructor(store: Store) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS wiki_pages(owner TEXT NOT NULL, space TEXT NOT NULL, slug TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        correction TEXT NOT NULL DEFAULT '', corrected_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner,space,slug));
      CREATE TABLE IF NOT EXISTS wiki_links(owner TEXT NOT NULL, space TEXT NOT NULL,
        from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, to_title TEXT NOT NULL,
        PRIMARY KEY(owner,space,from_slug,to_slug));
      CREATE INDEX IF NOT EXISTS wiki_links_to ON wiki_links(owner,space,to_slug);`);
  }

  /** Writes a page, replacing its body if the title already names one. A correction survives this. */
  write(owner: string, input: unknown): WikiPageView {
    const { space, title, body } = WriteSchema.parse(input);
    const flagged = detectInjection(`${title}\n${body}`);
    if (flagged.length) throw new Error("That page reads like instructions to the assistant rather than something to remember, so it was not saved.");
    const slug = slugOf(title), now = new Date().toISOString();
    const before = this.row(owner, space, slug);
    this.db.prepare(`INSERT INTO wiki_pages(owner,space,slug,title,body,revision,correction,corrected_at,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?,?,?)
      ON CONFLICT(owner,space,slug) DO UPDATE SET title=excluded.title, body=excluded.body,
        revision=wiki_pages.revision+1, updated_at=excluded.updated_at`)
      .run(owner, space, slug, title.slice(0, maximumTitleLength), body,
        before?.correction ?? "", before?.correctedAt ?? null, now, now);
    this.saveLinks(owner, space, slug, body);
    return this.view(owner, space, slug)!;
  }

  /**
   * Puts the owner's correction on a page, kept apart from the body so nothing afterwards —
   * another edit, another reading — can quietly drop it.
   */
  correct(owner: string, input: unknown): WikiPageView {
    const { space, title, correction } = CorrectSchema.parse(input);
    if (detectInjection(correction).length)
      throw new Error("That correction reads like instructions to the assistant rather than a fact, so it was not saved.");
    const slug = slugOf(title);
    const current = this.row(owner, space, slug);
    if (!current) throw new Error(`There is no page called "${title}" to correct. Write it first with wiki.write.`);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE wiki_pages SET correction=?, corrected_at=?, revision=revision+1, updated_at=? WHERE owner=? AND space=? AND slug=?")
      .run(correction, now, now, owner, space, slug);
    return this.view(owner, space, slug)!;
  }

  private saveLinks(owner: string, space: string, fromSlug: string, body: string): void {
    this.db.prepare("DELETE FROM wiki_links WHERE owner=? AND space=? AND from_slug=?").run(owner, space, fromSlug);
    for (const title of linksIn(body)) {
      const toSlug = slugOf(title);
      if (toSlug === fromSlug) continue;
      this.db.prepare("INSERT OR IGNORE INTO wiki_links(owner,space,from_slug,to_slug,to_title) VALUES(?,?,?,?,?)")
        .run(owner, space, fromSlug, toSlug, title.slice(0, maximumTitleLength));
    }
  }
  private row(owner: string, space: string, slug: string): WikiPage | null {
    const row = this.db.prepare("SELECT * FROM wiki_pages WHERE owner=? AND space=? AND slug=?").get(owner, space, slug);
    return row ? toPage(row) : null;
  }
  /** One page, with the titles it links to (each said whether it exists yet) and who links back to it. */
  view(owner: string, space: string, title: string): WikiPageView | null {
    const slug = slugOf(title);
    const page = this.row(owner, space, slug);
    if (!page) return null;
    return { ...page, links: this.outLinks(owner, space, slug), backlinks: this.backlinks(owner, space, slug) };
  }
  private outLinks(owner: string, space: string, slug: string): { slug: string; title: string; exists: boolean }[] {
    return this.db.prepare("SELECT to_slug, to_title FROM wiki_links WHERE owner=? AND space=? AND from_slug=? ORDER BY to_title")
      .all(owner, space, slug).map((link) => ({ slug: String(link.to_slug), title: String(link.to_title),
        exists: this.db.prepare("SELECT 1 FROM wiki_pages WHERE owner=? AND space=? AND slug=?")
          .get(owner, space, String(link.to_slug)) !== undefined }));
  }
  private backlinks(owner: string, space: string, slug: string): { slug: string; title: string }[] {
    return this.db.prepare(`SELECT p.slug, p.title FROM wiki_links l JOIN wiki_pages p
        ON p.owner=l.owner AND p.space=l.space AND p.slug=l.from_slug
      WHERE l.owner=? AND l.space=? AND l.to_slug=? ORDER BY p.title`).all(owner, space, slug)
      .map((row) => ({ slug: String(row.slug), title: String(row.title) }));
  }
  /** Every page in a space, most recently touched first, for the panel and for word search. */
  list(owner: string, space: string): WikiPage[] {
    return this.db.prepare("SELECT * FROM wiki_pages WHERE owner=? AND space=? ORDER BY updated_at DESC LIMIT 500")
      .all(owner, space).map(toPage);
  }
  /** Which pages a slug could plausibly mean — an exact title match first, then a loose word match. */
  private matches(owner: string, space: string, query: string): WikiPage[] {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length) return [];
    const pages = this.list(owner, space);
    const exact = pages.find((page) => page.slug === slugOf(query));
    if (exact) return [exact, ...pages.filter((page) => page.slug !== exact.slug)];
    return pages
      .map((page) => ({ page, score: words.filter((word) => `${page.title} ${page.body}`.toLowerCase().includes(word)).length }))
      .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.page);
  }
  /**
   * The best-matching page for a query, plus everything one hop out along its links — the "related
   * knowledge pages" the gap asks for. Every page comes back through `render()`, so a correction is
   * never left behind by following a link to, or from, the page that carries it.
   */
  follow(owner: string, input: unknown): { space: string; pages: WikiPage[]; text: string }[] {
    const { space, query, limit } = FollowSchema.parse(input);
    const found = this.matches(owner, space, query);
    if (!found.length) return [];
    const start = found[0]!;
    const gathered = new Map<string, WikiPage>([[start.slug, start]]);
    for (const link of [...this.outLinks(owner, space, start.slug), ...this.backlinks(owner, space, start.slug)]) {
      if (gathered.size >= limit) break;
      const page = this.row(owner, space, link.slug);
      if (page) gathered.set(page.slug, page);
    }
    const pages = [...gathered.values()].slice(0, limit);
    return [{ space, pages, text: pages.map(render).join("\n\n---\n\n") }];
  }
}

/** The wiki behind the common passage interface, so a search takes one hop through its links. */
export class WikiRetriever implements Retriever {
  readonly id = "wiki";
  readonly label = "Your wiki pages";
  constructor(private readonly wiki: WikiPages, private readonly spaces: (owner: string) => string[] = () => ["default"]) {}
  async retrieve(owner: string, query: string, limit: number): Promise<RetrievedPassage[]> {
    const found: RetrievedPassage[] = [];
    for (const space of this.spaces(owner)) {
      for (const group of this.wiki.follow(owner, { space, query, limit }))
        for (const page of group.pages) {
          found.push({ key: `wiki:${space}:${page.slug}`,
            source: page.correction ? `${page.title} (corrected)` : page.title,
            text: render(page), score: page.slug === slugOf(query) ? 1 : 0.6, from: this.id });
          if (found.length >= limit) return found;
        }
    }
    return found;
  }
}

function toPage(row: Record<string, unknown>): WikiPage {
  return {
    space: String(row.space), slug: String(row.slug), title: String(row.title), body: String(row.body),
    correction: String(row.correction ?? ""), correctedAt: row.corrected_at ? String(row.corrected_at) : null,
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
export function registerWiki(registry: ToolRegistry, wiki: WikiPages): void {
  registry.register({
    name: "wiki.write", group: "memory", permission: "memory.write",
    description: "Write or update a wiki page. Link to another page by writing its title in double square brackets, like [[Spare Key]].",
    parameters: WriteSchema,
    execute: async (input, context) => wiki.write(context.owner, input),
  });
  registry.register({
    name: "wiki.correct", group: "memory", permission: "memory.write",
    description: "Put a wiki page right. The correction is kept apart from the page's own words and is always shown first, however the page is read afterwards.",
    parameters: CorrectSchema,
    execute: async (input, context) => wiki.correct(context.owner, input),
  });
  registry.register({
    name: "wiki.view", group: "memory", permission: "memory.read",
    description: "Read one wiki page: its words, any correction, and which pages it links to and is linked from.",
    parameters: ViewSchema,
    execute: async (input, context) => {
      const { space, title } = ViewSchema.parse(input);
      const page = wiki.view(context.owner, space, title);
      if (!page) throw new Error(`There is no page called "${title}" in "${space}".`);
      return page;
    },
  });
  registry.register({
    name: "wiki.follow", group: "memory", permission: "memory.read",
    description: "Find the wiki page that best answers a question, then follow its links one hop out to bring back related pages too.",
    parameters: FollowSchema,
    execute: async (input, context) => wiki.follow(context.owner, input),
  });
}
