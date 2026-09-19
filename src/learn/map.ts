import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectMap } from "../code-map.js";
import { pageRank, rankDeclarations, type Edge } from "../code-rank.js";
import { cluster, type ClusterEdge, type ClusterNode } from "./cluster.js";
import type { LearnCitation, LearnMap, MapGroup, MapLink, MapThing } from "./types.js";

/**
 * mac7/learn: building the map, over a folder of code or a folder of documents, without calling a
 * model once.
 *
 * Both maps come out in the same shape, and both are built entirely on this computer:
 *
 *   Code. Branch already ranks a repository for nothing (src/code-rank.ts, after Aider): every file
 *   is a thing, a file that uses a name another file declares is a link to it, and a personalised
 *   PageRank says which files the rest lean on. The link's citation is the line where that name is
 *   declared, so "this file depends on that one" can be opened and checked.
 *
 *   Documents. There is no import graph, and that is the honest difference: a folder of PDFs states
 *   nothing about itself. What stands in for it is the entity map Branch already builds
 *   (src/knowledge-graph.ts), where the link between two names is "they were named in this passage"
 *   and every link already carries that passage. The same `pageRank` orders it, unchanged, because
 *   it takes plain nodes and weighted links and does not care where they came from.
 *
 * What is weaker without an import graph is said on the map rather than hidden: co-occurrence is a
 * guess at a relation, the reading order it gives is "most talked about first" and not "start
 * here", and a thing found by the reader on this computer rather than by a model is a run of
 * capitalised words and can be a person, a place or a heading. Those sentences come back in
 * `limits`, and the docs repeat them.
 */

export const mapLimits = { things: 400, links: 1200, perGroup: 60 } as const;
/** The separator for a composite key; never part of a path or a name. */
const SEP = "\u0000";

/** The map as a fingerprint of what it was built from, so nothing is rebuilt that has not changed. */
const fingerprint = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join(SEP)).digest("hex").slice(0, 32);

/* ---------- code ---------- */

/** The map of a folder of code. No model is called, and nothing leaves this computer. */
export async function codeMap(project: ProjectMap, path = ".", limit = mapLimits.things): Promise<LearnMap> {
  const { result, tagged } = await project.buildTagged(path, limit);
  const ranking = rankDeclarations(tagged);
  const declarations = new Map(tagged.map((file) => [file.path, file.defs]));
  const things: MapThing[] = result.files.map((file) => ({
    id: file.path, name: file.path,
    weight: ranking.fileRank.get(file.path) ?? 0,
    citation: firstDeclaration(file.path, declarations.get(file.path)),
  })).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const links = collapse(ranking.edges, declarations).slice(0, mapLimits.links);
  const groups = groupsOf(things, links, "code");
  const limits = ["The names come from a light reader, not a real parser, so a name inside a comment or a string can be read as a declaration."];
  if (!links.length) limits.push("No file in this folder uses a name another one declares, so the map has things but no links, and there is no reading order to follow.");
  return {
    subject: "code", of: path, things: things.slice(0, mapLimits.things), links, groups,
    version: fingerprint(result.files.map((file) => `${file.path}:${file.bytes}:${file.language}`)),
    how: `Built on this computer from ${result.files.length} file(s): who uses whose names, then a ranking. No model was called.`,
    limits, modelCalls: 0,
  };
}
interface Declared { name: string; line: number; text: string }
/** A file's citation: the first thing it declares, with the line. A file that declares nothing says so. */
function firstDeclaration(path: string, defs: readonly Declared[] | undefined): LearnCitation {
  const first = defs?.[0];
  return first ? { kind: "code", path, line: first.line, text: first.text }
    : { kind: "none", why: `${path} declares nothing the reader on this computer could find, so there is no line to open.` };
}
/**
 * One link per pair of files, keeping the name that carried the most weight between them, and
 * citing the line where that name is declared. A file's links to itself are dropped: they say
 * nothing about how the folder fits together.
 */
function collapse(edges: readonly Edge[], declarations: ReadonlyMap<string, readonly Declared[]>): MapLink[] {
  const best = new Map<string, { edge: Edge; weight: number }>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from}${SEP}${edge.to}`;
    const seen = best.get(key);
    const weight = (seen?.weight ?? 0) + edge.weight;
    best.set(key, { edge: !seen || edge.weight > seen.edge.weight ? edge : seen.edge, weight });
  }
  return [...best.values()]
    .sort((a, b) => b.weight - a.weight || a.edge.from.localeCompare(b.edge.from))
    .map(({ edge, weight }) => {
      const where = declarations.get(edge.to)?.find((def) => def.name === edge.name);
      return {
        from: edge.from, to: edge.to, relation: `uses ${edge.name}`, weight,
        citation: where ? { kind: "code" as const, path: edge.to, line: where.line, text: where.text }
          : { kind: "none" as const, why: `${edge.to} declares ${edge.name} somewhere the reader could not pin to a line.` },
      };
    });
}

/* ---------- documents ---------- */

/**
 * The map of a knowledge base, read out of the entity map Branch already keeps. Nothing here builds
 * that map -- `knowledge.map` does, and does it without a model by default -- so this is a view over
 * what is stored, which is the whole point: it adds no truth of its own.
 */
export function documentMap(
  db: DatabaseSync, owner: string, collection: string, visible: (docId: string) => boolean = () => true,
): LearnMap {
  const stored = db.prepare(`SELECT r.source, r.target, r.relation, r.chunk_id, c.doc_id, c.doc_name, c.heading, c.page
    FROM kb_relations r LEFT JOIN kb_chunks c ON c.owner=r.owner AND c.collection=r.collection AND c.chunk_id=r.chunk_id
    WHERE r.owner=? AND r.collection=? LIMIT ?`).all(owner, collection, mapLimits.links);
  // mac7/walk-rules: links read from files the rules keep the assistant out of are not shown, and
  // then neither is a name no shown link comes from (it may have been read only from such a file).
  const rows = stored.filter((row) => row.doc_id === null || row.doc_id === undefined || visible(String(row.doc_id)));
  const shownNames = new Set(rows.flatMap((row) => [String(row.source), String(row.target)]));
  const named = db.prepare("SELECT entity_id, name, kind, mentions FROM kb_entities WHERE owner=? AND collection=? ORDER BY mentions DESC LIMIT ?")
    .all(owner, collection, mapLimits.things).filter((row) => rows.length === stored.length || shownNames.has(String(row.entity_id)));
  const label = new Map(named.map((row) => [String(row.entity_id), String(row.name)]));
  const where = new Map<string, LearnCitation>();
  const links: MapLink[] = [];
  const edges: ClusterEdge[] = [];
  let guessed = 0;
  for (const row of rows) {
    const from = String(row.source), to = String(row.target);
    if (!label.has(from) || !label.has(to)) continue;
    const citation: LearnCitation = { kind: "passage", chunkId: String(row.chunk_id), document: String(row.doc_name ?? ""),
      heading: String(row.heading ?? ""), page: row.page === null || row.page === undefined ? null : Number(row.page) };
    for (const side of [from, to]) if (!where.has(side)) where.set(side, citation);
    const relation = String(row.relation);
    if (relation === "mentioned with") guessed += 1;
    links.push({ from: label.get(from)!, to: label.get(to)!, relation, weight: 1, citation });
    edges.push({ from, to, weight: 1 });
  }
  const rank = pageRank(named.map((row) => String(row.entity_id)),
    edges.map((edge) => ({ from: edge.from, to: edge.to, weight: edge.weight, name: "" })));
  const things: MapThing[] = named.map((row) => ({
    id: String(row.name), name: String(row.name),
    weight: rank.get(String(row.entity_id)) ?? 0,
    citation: where.get(String(row.entity_id))
      ?? { kind: "none", why: `"${String(row.name)}" is in ${String(row.mentions)} passage(s) but is linked to nothing, so the map has no passage to show for it.` },
  })).sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const groups = groupsOf(things, links, "documents");
  const limits: string[] = [];
  if (guessed) limits.push('Links marked "mentioned with" only mean the two names turned up in the same passage. They do not say how the two are related, and the map does not pretend to know.');
  limits.push("A folder of documents says nothing about its own structure the way code does, so there is no natural starting point: the order here is what the files talk about most, not where to begin.");
  if (!things.length) limits.push("This collection has no map yet. Build one with knowledge.map, which also runs without a model.");
  return {
    subject: "documents", of: collection, things, links, groups,
    version: collectionVersion(db, owner, collection),
    how: `Read from the map already stored for this collection: ${things.length} thing(s) and ${links.length} link(s), each with the passage it came from. No model was called.`,
    limits, modelCalls: 0,
  };
}
/** The same fingerprint `KnowledgeSummaries.version` uses, so both go stale at the same moment. */
export function collectionVersion(db: DatabaseSync, owner: string, collection: string): string {
  const row = db.prepare(`SELECT COUNT(*) AS n, group_concat(text_hash) AS hashes FROM
    (SELECT text_hash FROM kb_chunks WHERE owner=? AND collection=? ORDER BY chunk_id)`).get(owner, collection);
  return fingerprint([String(Number(row?.n ?? 0)), String(row?.hashes ?? "")]);
}

/* ---------- groups ---------- */

/**
 * The groups, named after the heaviest thing in each. The name is never written by a model: it is
 * a thing already on the map, so the group's citation is that thing's citation and a person can go
 * and look at the reason the group is called what it is.
 */
function groupsOf(things: readonly MapThing[], links: readonly MapLink[], subject: "code" | "documents"): MapGroup[] {
  const nodes: ClusterNode[] = things.map((thing) => ({ id: thing.id, weight: thing.weight }));
  const found = cluster(nodes, links.map((link) => ({ from: link.from, to: link.to, weight: link.weight })));
  const byId = new Map(things.map((thing) => [thing.id, thing]));
  return found.map((group) => {
    const members = [...group.members].sort((a, b) => (byId.get(b)?.weight ?? 0) - (byId.get(a)?.weight ?? 0) || a.localeCompare(b));
    const head = byId.get(members[0] ?? "");
    return {
      id: group.id,
      name: head ? (members.length > 1 ? `${shortName(head.name, subject)} and ${members.length - 1} more` : shortName(head.name, subject)) : `${members.length} things`,
      things: members.slice(0, mapLimits.perGroup),
      citation: head?.citation ?? { kind: "none", why: "This group has nothing in it to point at." },
    };
  });
}
/** A file path shortened to the part a person reads; a name left as it is written. */
const shortName = (name: string, subject: "code" | "documents"): string =>
  subject === "code" ? (name.split("/").pop() ?? name) : name;
