import {
  keepPageNote, listPageNotes, makePageNote, pageNoteFollowUp, pageNotesSettings, requirePageNotes,
  resolvePageNote, savePageNotesSettings,
} from "./browser-annotations.js";
import type { Store } from "./store.js";

/**
 * w911 (A2144): the page-note routes, in one function so src/server.ts gains a single hook line.
 *
 *   GET/POST /api/browser/notes/settings        the switch (the owner's alone)
 *   GET      /api/browser/notes[?conversation=]  the notes of whoever is using Branch
 *   POST     /api/browser/notes                  a new note; with a conversation it becomes that conversation's next message
 *   POST     /api/browser/notes/:id/resolve      takes a dealt-with note off the list
 */
export interface PageNotesDeps {
  /** Notes are kept under `store.profiles.scope()`: the owner, or the household profile in use. */
  store: Store;
  /** The switch is kept under `runtime.owner`; a note with a conversation is queued with `followUp`. */
  runtime: { owner: string; followUp(sessionId: string, prompt: string): unknown };
}

export const handlesPageNotes = (path: string): boolean =>
  path === "/api/browser/notes" || path.startsWith("/api/browser/notes/");

const resolvePath = /^\/api\/browser\/notes\/([a-f0-9-]{36})\/resolve$/;

export async function pageNotesApi(
  deps: PageNotesDeps, method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/browser/notes/settings") {
    deps.store.profiles.requireOwner("The page-notes switch");
    const owner = deps.runtime.owner;
    if (method === "POST") return { settings: savePageNotesSettings(deps.store, owner, await body()) };
    if (method === "GET") return { settings: pageNotesSettings(deps.store, owner) };
    throw new Error("Use GET or POST");
  }
  requirePageNotes(deps.store, deps.runtime.owner);
  const scope = deps.store.profiles.scope();
  if (path === "/api/browser/notes" && method === "GET")
    return { notes: listPageNotes(deps.store, scope, query.get("conversation") || undefined) };
  if (path === "/api/browser/notes" && method === "POST") return addNote(deps, scope, await body());
  const resolving = resolvePath.exec(path);
  if (resolving && method === "POST") return resolvePageNote(deps.store, scope, resolving[1]!);
  throw new Error("That is not something page notes can do");
}

/** Keeps the note, and when it names a conversation of this person's, queues it there. */
function addNote(deps: PageNotesDeps, scope: string, input: unknown): unknown {
  const note = makePageNote(input);
  if (note.conversationId && !deps.store.ownsSession(scope, note.conversationId))
    throw new Error("Conversation not found");
  // Queued first, so a refusal there leaves no note behind; the queued task starts only after this returns.
  const queued = note.conversationId ? deps.runtime.followUp(note.conversationId, pageNoteFollowUp(note)) : null;
  keepPageNote(deps.store, scope, note);
  return { note, ...(queued ? { followUp: queued } : {}) };
}
