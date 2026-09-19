import { z } from "zod";
import type { Trunks } from "./index.js";
import { TrunkOffError, TrunkPartSchema, trunkLabels, trunkParts } from "./settings.js";

/**
 * The web side of R17-A: the owner's routes under /api/trunks. They sit behind the same key and host
 * rules as everything else. A short-lived "run" key may only talk to a Trunk and to a room, and stop
 * a room (src/short-lived-keys.ts); every other change is the owner's.
 */
export const handlesTrunksPath = (path: string): boolean => path === "/api/trunks" || path.startsWith("/api/trunks/");

export class TrunksHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface TrunksHttpDeps {
  trunks: Trunks;
  method: string;
  readBody: () => Promise<unknown>;
}

const SwitchSchema = z.object({ part: TrunkPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();
const TextSchema = z.object({ text: z.string().trim().min(1).max(16000) }).strict();
const trunkPath = /^\/api\/trunks\/([a-f0-9-]{36})(?:\/(remove|say|seen|retire|avatar|export|keys|routines|watch|teach))?$/;
const roomPath = /^\/api\/trunks\/rooms\/([a-f0-9-]{36})(?:\/(remove|send|stop|answer|revoke))?$/; // phase2/rooms: revoke
const routinePath = /^\/api\/trunks\/routines\/([a-f0-9-]{36})\/remove$/;
/** mac7/residuals (integration): Answer / Not now on a Trunk's message that waits for the owner. */
const messagePath = /^\/api\/trunks\/messages\/([a-f0-9-]{36})\/(answer|decline)$/;
/** phase2/rooms: who answers in a conversation (src/trunks/conversations.ts). */
const conversationPath = /^\/api\/trunks\/conversations(?:\/([a-f0-9-]{36})(?:\/(room))?)?$/;

async function conversationRoute(deps: TrunksHttpDeps, id: string | undefined, action: string | undefined): Promise<unknown> {
  const { trunks } = deps, post = deps.method === "POST";
  trunks.require("trunks");
  if (!id) {
    if (!post) return undefined;
    trunks.require("conversations");
    return trunks.startConversation(await deps.readBody());
  }
  if (!post) return trunks.conversations.info(id);
  if (!action) {
    // Integration review: giving a conversation back to your assistant works with the switch off too,
    // so a Trunk chosen before it was switched off never holds the conversation for good.
    const body = await deps.readBody();
    if ((body as { trunkId?: unknown } | null)?.trunkId !== null) trunks.require("conversations");
    return trunks.conversations.choose(id, body);
  }
  trunks.require("conversations");
  trunks.require("rooms");
  return { room: trunks.conversations.room(id, await deps.readBody()) };
}

function overview(trunks: Trunks) {
  const modes = trunks.modes();
  return { modes, labels: trunkParts.map((part) => ({ part, label: trunkLabels[part] })),
    ...(modes.trunks === "off" ? { trunks: [], rooms: [] } : trunks.roster()) };
}

async function topRoute(deps: TrunksHttpDeps, path: string): Promise<unknown> {
  const { trunks, method } = deps, post = method === "POST";
  if (path === "/api/trunks") return post ? { trunk: trunks.create(await deps.readBody()) } : overview(trunks);
  if (!post) return undefined;
  if (path === "/api/trunks/switch") {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { modes: trunks.setMode(part, { mode }) };
  }
  if (path === "/api/trunks/import") return { trunk: trunks.importFile(await deps.readBody()) };
  if (path === "/api/trunks/from-specialist") {
    const { specialistId } = z.object({ specialistId: z.string().uuid() }).strict().parse(await deps.readBody());
    return { trunk: trunks.fromSpecialist(specialistId) };
  }
  if (path === "/api/trunks/rooms") {
    trunks.require("rooms");
    return { room: trunks.rooms.create(await deps.readBody()) };
  }
  const routine = routinePath.exec(path);
  if (routine) return trunks.routines.remove(routine[1]!);
  const message = messagePath.exec(path);
  if (message) return message[2] === "answer" ? { waiting: trunks.messages.answer(message[1]!) } : trunks.messages.decline(message[1]!);
  return undefined;
}

async function trunkRoute(deps: TrunksHttpDeps, id: string, action: string | undefined): Promise<unknown> {
  const { trunks } = deps, post = deps.method === "POST";
  if (!action) return post ? { trunk: trunks.edit(id, await deps.readBody()) } : details(trunks, id);
  if (action === "export") return trunks.exportFile(id);
  if (action === "keys") return trunks.keys(id);
  if (!post) return undefined;
  switch (action) {
    case "remove": return trunks.remove(id);
    case "say": return trunks.say(id, TextSchema.parse(await deps.readBody()).text);
    case "seen": return trunks.markSeen(id);
    case "retire": return { trunk: trunks.retireChat(id) };
    case "avatar": return { trunk: await trunks.setAvatar(id, await deps.readBody()) };
    case "routines": return { routine: trunks.routines.create(id, await deps.readBody()) };
    case "watch": return trunks.teaching.watch(id);
    case "teach": return trunks.teaching.save(id, await deps.readBody());
    default: return undefined;
  }
}

function details(trunks: Trunks, id: string) {
  trunks.require("trunks");
  const trunk = trunks.records.get(id);
  return { trunk, routines: trunks.routines.list(id), receipts: trunks.messages.receipts(id).slice(0, 20),
    watching: trunks.teaching.watching(id), keys: trunks.keys(id) };
}

async function roomRoute(deps: TrunksHttpDeps, id: string, action: string | undefined): Promise<unknown> {
  const { trunks } = deps, rooms = trunks.rooms, post = deps.method === "POST";
  trunks.require("rooms");
  if (!action) return post ? { room: rooms.edit(id, await deps.readBody()) } : rooms.view(id);
  if (!post) return undefined;
  if (action === "remove") return rooms.remove(id);
  if (action === "send") return rooms.send(id, await deps.readBody());
  if (action === "stop") return rooms.stop(id);
  if (action === "revoke") return rooms.revoke(id, await deps.readBody()); // phase2/rooms (integration review)
  return { answered: rooms.answer(id, await deps.readBody()) };
}

const notFound = (): never => { throw new TrunksHttpError(404, "There is nothing at that address"); };

/** Answers one request under /api/trunks. */
export async function trunksApi(deps: TrunksHttpDeps, path: string): Promise<unknown> {
  try {
    const conversation = conversationPath.exec(path); // phase2/rooms
    if (conversation) return await conversationRoute(deps, conversation[1], conversation[2]) ?? notFound();
    const room = roomPath.exec(path);
    const trunk = room ? null : trunkPath.exec(path);
    const answer = room ? await roomRoute(deps, room[1]!, room[2])
      : trunk ? await trunkRoute(deps, trunk[1]!, trunk[2])
        : await topRoute(deps, path);
    if (answer === undefined) throw new TrunksHttpError(404, "There is nothing at that address");
    return answer;
  } catch (error) {
    if (error instanceof TrunksHttpError) throw error;
    if (error instanceof TrunkOffError) throw new TrunksHttpError(409, error.message);
    if (error instanceof z.ZodError) throw new TrunksHttpError(400, error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") throw new TrunksHttpError(status, (error as Error).message);
    throw new TrunksHttpError(400, error instanceof Error ? error.message : String(error));
  }
}
