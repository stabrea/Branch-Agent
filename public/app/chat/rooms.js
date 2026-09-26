/* Trunks in a conversation (prototype block(): a room's replies signed with the Trunk's face, and its name when the
   speaker changes), wired to the engine's own routes (src/trunks/api.ts, src/trunks/conversations.ts):
   - who answers here and who wrote each reply: GET /api/trunks/conversations/<id> (kind, trunk, room, authors), read by
     the + menu (plus.js loadWho) and shared from there;
   - where a message goes, as the engine expects it (the old window's rooms.js routeFor): a room's message goes to
     POST /api/trunks/rooms/<id>/send; "@name …" with choosing a Trunk switched off goes to that Trunk's own chat
     (POST /api/trunks/<id>/say); "@name …" in a conversation your assistant answers makes that Trunk answer here from now
     on (POST /api/trunks/conversations or /api/trunks/conversations/<id>) and is then sent as usual;
   - a room member waiting for a yes: GET /api/trunks/rooms/<id> waiting, answered for that exact request with
     POST /api/trunks/rooms/<id>/answer { memberId, decision, fingerprint }. */

import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";

const R = { view: null, viewFor: null };

const modeOn = (part) => (E.trunkModes?.trunks ?? "on") !== "off" && (E.trunkModes?.[part] ?? "on") !== "off";
const trunkBy = (id, info) => E.trunks.find((t) => t.id === id) ?? info?.trunks?.find((t) => t.id === id)
  ?? info?.room?.members?.find((t) => t.id === id) ?? (info?.trunk?.id === id ? info.trunk : null);
const byHandle = (handle, info) => {
  const h = String(handle).toLowerCase();
  return E.trunks.find((t) => !t.hidden && t.handle === h) ?? info?.room?.members?.find((t) => t.handle === h) ?? null;
};

/** The Trunks a message names with @handle, in order, each once. */
export function named(text, info) {
  const found = [];
  for (const match of String(text).matchAll(/(?:^|\s)@([a-z0-9][\w-]*)/gi)) {
    const trunk = byHandle(match[1], info);
    if (trunk && !found.includes(trunk)) found.push(trunk);
  }
  return found;
}

/* ---------- who wrote a reply ---------- */
const ROOM_REPLY = /^@([a-z0-9][\w.-]*):\s*/i;
/** A room's reply is kept as "@handle: words"; the words without the handle. */
export const replyWords = (m, info) => (info?.kind === "room" ? String(m.content ?? "").replace(ROOM_REPLY, "") : m.content);

/** The Trunk that wrote this reply, or null for your assistant. `index` counts the replies before it the way the engine
   does (assistant messages that call no tool). */
export function authorOf(m, index, info) {
  if (!info) return null;
  if (info.kind === "room") { const at = ROOM_REPLY.exec(String(m.content ?? "")); return at ? byHandle(at[1], info) : null; }
  if (info.kind === "trunk-chat" || info.kind === "member") return info.trunk ? trunkBy(info.trunk.id, info) ?? info.trunk : null;
  /* A conversation that changed hands (kind trunk, or plain again after a Trunk answered) keeps who gave each reply. */
  if (info.kind !== "trunk" && info.kind !== "plain") return null;
  const answered = [...(info.authors ?? [])].filter((a) => a.from <= index).at(-1);
  return answered?.trunkId ? trunkBy(answered.trunkId, info) : null;
}
export const countsAsReply = (m) => m.role === "assistant" && !m.toolCalls?.length;

/* ---------- where a message goes ---------- */
/** What sending `text` means here, as a function to run, or null when the ordinary send does it. `hooks` are the
   conversation's own: open(id), sendPlain(text), after(). */
export function routeFor(text, sid, info, hooks) {
  if (info?.kind === "room" && info.room) return () => sendToRoom(info, text, hooks);
  const names = named(text, info);
  if (!names.length || !modeOn("trunks")) return null;
  if (!modeOn("conversations")) {
    const match = /^@([a-z0-9][\w-]*)\s+([\s\S]+)$/i.exec(text.trim());
    const trunk = match && byHandle(match[1], info);
    return trunk?.chatSessionId ? () => sayToTrunk(trunk, match[2].trim(), hooks) : null;
  }
  const kind = info?.kind ?? (sid ? null : "plain");
  if (kind !== "plain") return null;
  return () => chooseAndSend(names[0], sid, text, hooks);
}

async function sendToRoom(info, text, hooks) {
  await api(`trunks/rooms/${encodeURIComponent(info.room.id)}/send`, { text });
  await hooks.followRoom(info);
}
async function sayToTrunk(trunk, text, hooks) {
  await hooks.open(trunk.chatSessionId);
  await api(`trunks/${encodeURIComponent(trunk.id)}/say`, { text });
  await hooks.open(trunk.chatSessionId);
}
async function chooseAndSend(trunk, sid, text, hooks) {
  if (sid) await api(`trunks/conversations/${encodeURIComponent(sid)}`, { trunkId: trunk.id });
  else await hooks.open((await api("trunks/conversations", { trunkId: trunk.id })).sessionId);
  await hooks.after();
  await hooks.sendPlain(text);
}

/* ---------- a room's own state: speaking, and who waits for a yes ---------- */
export async function readRoom(info) {
  if (info?.kind !== "room" || !info.room) { R.view = null; R.viewFor = null; return null; }
  try { R.view = await api(`trunks/rooms/${encodeURIComponent(info.room.id)}`); R.viewFor = info.room.id; } catch { R.view = null; }
  return R.view;
}
export const roomView = (info) => (info?.kind === "room" && R.viewFor === info.room?.id ? R.view : null);

/* A room member's question, 1:1 with the conversation's approval card; the buttons name the room, the member and the
   exact request. */
export function roomAsks(info, busy) {
  const view = roomView(info);
  return (view?.waiting ?? []).map((q) => {
    const who = trunkBy(q.memberId, info);
    const off = busy(q) ? " disabled" : "";
    const id = `data-room="${esc(info.room.id)}" data-member="${esc(q.memberId)}" data-fp="${esc(q.fingerprint || "")}"${off}`;
    return `<div class="b"><div class="gut"></div><div>${who ? `<div class="from">${esc(who.name)}</div>` : ""}<div class="card ask" id="live-ask"><div class="card-h"><span class="q">${esc(q.label)}</span><span class="pill work ml"><i></i>Needs you</span></div>
      <div class="acts"><button class="btn pri" type="button" data-act="room-ask" data-v="allow" ${id}>Allow</button><button class="btn ghost" type="button" data-act="room-ask" data-v="deny" ${id}>Don’t allow</button></div></div></div></div>`;
  }).join("");
}
export async function answerRoom(el, decision) {
  return api(`trunks/rooms/${encodeURIComponent(el.dataset.room)}/answer`, { memberId: el.dataset.member, decision, ...(el.dataset.fp ? { fingerprint: el.dataset.fp } : {}) });
}
