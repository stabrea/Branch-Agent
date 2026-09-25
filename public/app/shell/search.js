/* The sidebar's search results, 1:1 with the prototype's: filter chips with counts, then Chats and Trunks (titles and
   answering Trunks), Messages (words inside conversations, from GET /api/search), Past sessions and Files and memory
   (what the engine remembers). Each row opens what it found; matches are marked. */

import { esc } from "../core/dom.js";
import { ic, av } from "../core/ui.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";

export const SQ = { q: "", f: "all", hits: [], asked: "" };

/* The words around the first match, the match marked. */
const hl = (text, q) => {
  const t = String(text ?? ""), i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(t.slice(0, 90));
  const a = Math.max(0, i - 36), s = t.slice(a, i + q.length + 60), j = i - a;
  return (a ? "…" : "") + esc(s.slice(0, j)) + "<mark>" + esc(s.slice(j, j + q.length)) + "</mark>" + esc(s.slice(j + q.length)) + (i + q.length + 60 < t.length ? "…" : "");
};
const idOf = (s) => s.sessionId ?? s.id;
const titleOf = (s) => s.opening || s.title || "";
const trunkOf = (s) => E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id);

/* Asks the engine for words inside conversations; the caller draws again when the answer lands. */
export async function askEngine(q) {
  const answer = await api("search?q=" + encodeURIComponent(q)).catch(() => null);
  if (q !== SQ.q.trim()) return false;
  SQ.hits = answer?.results ?? [];
  SQ.asked = q;
  return true;
}

function found(q) {
  const lq = q.toLowerCase();
  const chats = E.sessions.filter((s) => titleOf(s).toLowerCase().includes(lq) || (trunkOf(s)?.name ?? "").toLowerCase().includes(lq));
  const inside = SQ.asked === q ? SQ.hits.filter((h) => h.kind === "conversation") : [];
  const msgs = inside.map((h) => ({ id: String(h.link ?? "").split("/").pop(), snippet: h.snippet ?? "" })).filter((m) => m.id);
  const memory = (E.state?.memory ?? []).filter((m) => JSON.stringify(m.data ?? m).toLowerCase().includes(lq));
  return { chats, msgs, sessions: [], memory };
}

export function searchHTML() {
  const q = SQ.q.trim(), f = SQ.f, r = found(q);
  const count = { all: r.chats.length + r.msgs.length + r.sessions.length + r.memory.length, chats: r.chats.length, msgs: r.msgs.length, sessions: r.sessions.length, files: r.memory.length };
  const chips = `<div class="sq-chips">${[["all", "All"], ["chats", "Chats"], ["msgs", "Messages"], ["sessions", "Past"], ["files", "Files"]].map(([v, l]) => `<button type="button" data-act="sq-f" data-v="${v}" aria-pressed="${f === v}">${l}${count[v] ? ` <em>${count[v]}</em>` : ""}</button>`).join("")}</div>`;
  const sec = (k, title, html) => ((f === "all" || f === k) && html ? `<div class="lh">${title}</div>${html}` : "");
  const session = (id) => E.sessions.find((s) => idOf(s) === id);
  const body = sec("chats", "Chats and Trunks", r.chats.map((s) => `<button type="button" class="sr-row" data-act="chat" data-id="${esc(idOf(s))}">${av(trunkOf(s) ?? { kind: "main" }, 34)}<span><b>${hl(titleOf(s), q)}</b><small>${esc(trunkOf(s)?.name ?? "")}</small></span></button>`).join(""))
    + sec("msgs", "Messages", r.msgs.slice(0, 40).map((m) => `<button type="button" class="sr-row msg9" data-act="chat" data-id="${esc(m.id)}">${av(trunkOf(session(m.id) ?? {}) ?? { kind: "main" }, 34)}<span><b>${esc(titleOf(session(m.id) ?? {}))}</b><small>${hl(m.snippet, q)}</small></span></button>`).join(""))
    + sec("files", "Files and memory", r.memory.map((m) => `<button type="button" class="sr-row" data-act="view" data-v="library"><span class="ico-tile sm9">${ic("book", "s")}</span><span><b>${hl(m.data?.text ?? m.data?.fact ?? m.data?.content ?? "", q)}</b><small>Memory</small></span></button>`).join(""));
  return chips + (body || `<p class="sq-none">No chats, messages or files with “${esc(q)}”.<br><button class="link" type="button" data-act="sq-f" data-v="sessions">Look in past sessions</button></p>`);
}
