import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { broughtServers, broughtSettings, bringOver, type ContextFileSink } from "./migrate/apply.js";
import { placesFor, type PlaceInput } from "./migrate/detect.js";
import { movedIn } from "./migrate/record.js";
import { foundSources, offerSentence, placeInput, previewOf, recognise, scanSource, type ScanInput } from "./migrate/scan.js";
import { archiveTree, folderTree, openSource } from "./migrate/source-tree.js";
import { moveInMode, requireMoveInAllowed, saveMoveInMode } from "./migrate/switch.js";
import { MoveInSourceSchema, sourceNames, type MoveInSource } from "./migrate/types.js";

/**
 * Moving in: bringing chats, memory, instructions, skills, tool servers and settings over from
 * Claude Code, Codex CLI, Hermes Agent, OpenClaw or OpenCode. The preview only reads; nothing in
 * Branch changes until the owner ticks what to bring and presses the button. Only the owner may do
 * either, because both read files on this computer.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export class MoveInApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function handlesMoveInPath(path: string): boolean {
  return /^\/api\/move-in(\/|$)/.test(path);
}

/**
 * Where to look. `BRANCH_MOVE_IN_HOME` points the search at another home folder, such as an old
 * disk; the assistants' own overrides (`CODEX_HOME` and the like) then no longer apply, because
 * they describe this computer's home folder and not that one.
 */
export interface MoveInOptions {
  platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string;
  /** The loader that owns AGENTS.md, SOUL.md and the like, once the launch provides one. */
  contextFiles?: ContextFileSink;
}
export function defaultMoveInOptions(env: Record<string, string | undefined> = process.env): MoveInOptions {
  const elsewhere = env.BRANCH_MOVE_IN_HOME?.trim();
  return elsewhere ? { platform: process.platform, env: {}, home: elsewhere }
    : { platform: process.platform, env, home: homedir() };
}

export const maximumUploadBytes = 32 * 1024 * 1024;
const SourceRequestSchema = z.object({
  source: MoveInSourceSchema.optional(),
  /** A folder, or a .zip / .tar / .tar.gz file, somewhere on this computer. */
  path: z.string().trim().min(1).max(4096).optional(),
  /** Or the same kind of file, sent from the page. */
  archive: z.object({ name: z.string().trim().min(1).max(260), data: z.base64().max(Math.ceil(maximumUploadBytes / 3) * 4) }).strict().optional(),
}).strict().refine((body) => !(body.path && body.archive), "Choose a folder or a file, not both")
  .refine((body) => body.source || body.path || body.archive, "Say which assistant to bring things over from");
const ImportSchema = z.object({ items: z.array(z.string().regex(/^[0-9a-f]{32}$/)).min(1).max(20_000) }).strict();

/** The trees to read and which assistant they belong to, for what the owner asked for. */
async function opened(body: z.infer<typeof SourceRequestSchema>, options: PlaceInput): Promise<{ source: MoveInSource; input: ScanInput }> {
  if (!body.path && !body.archive) {
    const place = placesFor(options).find((entry) => entry.source === body.source)!;
    return { source: place.source, input: placeInput(place) };
  }
  if (body.path && !isAbsolute(body.path)) throw new MoveInApiError(400, "Give the whole path to the folder or file, starting from the top of the disk");
  const tree = body.archive
    ? archiveTree(body.archive.name, Buffer.from(body.archive.data, "base64"))
    : await openSource(body.path!).catch((error: Error) => { throw new MoveInApiError(400, error.message); });
  const source = body.source ?? await recognise(tree);
  if (!source) throw new MoveInApiError(400, "Branch could not tell which assistant this came from. Choose it from the list and try again.");
  const input: ScanInput = { tree, extras: {} };
  // A copied `.claude` folder often has its `.claude.json` right beside it; that one file is read too.
  if (source === "claude-code" && body.path && basename(body.path) === ".claude")
    input.extras["claude-json"] = folderTree(dirname(body.path), [".claude.json"]);
  return { source, input };
}

async function withScan<T>(body: unknown, options: PlaceInput,
  use: (source: MoveInSource, from: string, scan: Awaited<ReturnType<typeof scanSource>>) => Promise<T>): Promise<T> {
  const request = SourceRequestSchema.parse(body);
  const { source, input } = await opened(request, options);
  const scan = await scanSource(source, input);
  try { return await use(source, input.tree.label, scan); }
  finally { await scan.close?.(); }
}

export async function moveInApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
  options: MoveInOptions = defaultMoveInOptions(),
): Promise<unknown> {
  const owner = app.runtime.owner, get = request.method === "GET", post = request.method === "POST";
  try { app.store.profiles.requireOwner("Bringing things over from another assistant"); }
  catch (error) { throw new MoveInApiError(403, (error as Error).message); }
  if (path === "/api/move-in/switch") {
    if (post) saveMoveInMode(app.store, owner, await readBody(request));
    else if (!get) throw new MoveInApiError(405, "Use GET or POST");
    return { mode: moveInMode(app.store, owner) };
  }
  const mode = moveInMode(app.store, owner);
  if (get && path === "/api/move-in") {
    // Off looks at nothing; "when needed" looks only when the owner asks; on looks whenever the card is shown.
    const asked = new URL(request.url ?? "/", "http://branch.invalid").searchParams.get("look") === "1";
    if (mode === "off" || (mode === "when-needed" && !asked)) return { mode, sources: [], offer: null };
    const sources = await foundSources(app.store, owner, options);
    return { mode, sources, offer: mode === "on" ? offerSentence(sources) : null };
  }
  if (get && path === "/api/move-in/brought")
    return { servers: broughtServers(app.store, owner), settings: broughtSettings(app.store, owner),
      counts: Object.fromEntries(MoveInSourceSchema.options.map((source) => [source, Object.keys(movedIn(app.store, owner, source)).length])) };
  const limit = Math.ceil(maximumUploadBytes / 3) * 4 + 1024 * 1024;
  if (post && (path === "/api/move-in/preview" || path === "/api/move-in/import")) {
    try { requireMoveInAllowed(mode); } catch (error) { throw new MoveInApiError(403, (error as Error).message); }
  }
  if (post && path === "/api/move-in/preview")
    return withScan(await readBody(request, limit), options,
      async (source, from, scan) => previewOf(app.store, owner, source, from, scan));
  if (post && path === "/api/move-in/import") {
    const body = await readBody(request, limit) as Record<string, unknown> | null;
    const { items } = ImportSchema.parse({ items: body?.items });
    const { items: _items, ...where } = body ?? {};
    const project = app.store.projects.active(owner).id;
    const held = new Set(app.store.locker.names(owner, project).map((entry) => entry.name));
    return withScan(where, options, async (source, from, scan) => ({
      source, name: sourceNames[source], from,
      ...await bringOver(app.store, owner, source, scan, items, held, options.contextFiles),
    }));
  }
  throw new MoveInApiError(404, "Endpoint not found");
}
