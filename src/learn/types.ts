/**
 * mac7/learn: what a map and a tour are made of.
 *
 * The one rule this whole feature rests on is in `LearnCitation`. Every claim a map or a tour makes —
 * a group's name, a link between two things, a stop in the tour — carries the place it was read
 * from, and a person can open that place. A claim with nothing behind it is not hidden: it carries
 * `{ kind: "none", why }`, which is printed on the claim itself. A confident sentence aimed at
 * somebody who cannot check it is how a wrong map teaches the wrong shape invisibly, so there is no
 * way to leave the field out and no way for it to come back empty.
 */

/** Where a claim was read from: a passage in a document, a line of code, or plainly nothing. */
export type LearnCitation =
  | {
    kind: "passage";
    /** The file the passage is in, its heading and its page, as the knowledge base stored them. */
    document: string; heading: string; page: number | null; chunkId: string;
  }
  | { kind: "code"; path: string; line: number; text: string }
  | { kind: "none"; why: string };

/** The one sentence a person reads under a claim, saying where it came from. */
export function citationLine(citation: LearnCitation): string {
  if (citation.kind === "passage") {
    const where = [citation.document || "a document", citation.heading || ""].filter(Boolean).join(" — ");
    return citation.page === null ? where : `${where}, page ${citation.page}`;
  }
  if (citation.kind === "code") return `${citation.path}, line ${citation.line}`;
  return citation.why;
}
/** True when a person can go and check this for themselves. */
export const canBeOpened = (citation: LearnCitation): boolean => citation.kind !== "none";

/** One thing on the map: a file, or a named thing a set of documents talks about. */
export interface MapThing {
  id: string;
  name: string;
  /** How much of the map leans on it, from the ranking. Nothing to do with how good it is. */
  weight: number;
  citation: LearnCitation;
}
/** One link between two things, with the passage or line it was read from. */
export interface MapLink { from: string; to: string; relation: string; weight: number; citation: LearnCitation }
/**
 * A group of things that belong together. The name is taken from the heaviest thing in the group,
 * never written by a model, so it cites that thing's own source rather than an invention.
 */
export interface MapGroup { id: string; name: string; things: string[]; citation: LearnCitation }

export type MapSubject = "code" | "documents";
export interface LearnMap {
  subject: MapSubject;
  /** The project's folder for code, or the collection's id for documents. */
  of: string;
  things: MapThing[];
  links: MapLink[];
  groups: MapGroup[];
  /** A fingerprint of what the map was built from, so it is not rebuilt when nothing has changed. */
  version: string;
  /** Plain English saying which path ran and what it could not do. */
  how: string;
  limits: string[];
  /** How many model calls went into it. A map is built without one, so this is 0. */
  modelCalls: number;
}

/** One stop on the tour. `words` is the only part a model ever writes, and it is marked as such. */
export interface TourStep {
  order: number;
  title: string;
  /** The things on the map this stop is about, lit up while it is on screen. */
  things: string[];
  citation: LearnCitation;
  words: string;
  /** True when `words` came from a model rather than from the map itself. */
  writtenByModel: boolean;
}
export interface LearnTour {
  subject: MapSubject;
  of: string;
  steps: TourStep[];
  /** The language the words were asked for and written in (a BCP-47 tag: "en", "fr"). */
  language: string;
  how: string;
  limits: string[];
  modelCalls: number;
}
