/* Two things from the conversation's header and menu (design doc 4.3, pass 10 and 15).
   - Open another conversation beside: a second conversation read with GET /api/sessions/{id}, drawn next to this one
     on a wide window (the split closes itself below 1000px, as the prototype's does).
   - Who it knows: the Trunks this computer has (GET /api/trunks) and the Trunks on the owner's other computers
     (POST /api/reach/trunks/remote, which only looks). The per-row "may talk to" switches, the hops note and "Connect another agent" stay
     greyed until the window can do them. */

import { $, esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";
import { mediaRows } from "./media.js";

const V = { id: null, messages: [], loaded: null };
const sid = (s) => s.sessionId ?? s.id;
const nameOf = (id) => E.sessions.find((s) => sid(s) === id)?.opening || "";

/* ---------- the conversation beside ---------- */
export function chatMenuTop() {
  return mi("beside15", "cols15", S.beside15 ? "Change the conversation beside" : "Open another conversation beside") + mi("roster10", "spark", "Who it knows") + "<hr>";
}

function besidePop() {
  const rows = E.sessions.filter((s) => sid(s) !== S.chat).slice(0, 8).map((s) => `<button class="mi" type="button" data-act="beside15" data-v="${esc(sid(s))}">${av({ kind: "main" }, 22)}<span><span class="mi-t">${esc(s.opening || "")}</span><span class="mi-s">${esc(String(s.lastMessage || "").slice(0, 44))}</span></span></button>`).join("");
  return `<div class="ph">Open beside this one</div>${rows}`;
}

function thread(messages, session) {
  let last = null;
  return messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch").map((m) => {
    const html = m.role === "user"
      ? `<div class="u">${esc(m.content)}</div>${mediaRows(m, session)}`
      : `<div class="b"><div class="gut">${last !== "assistant" ? av({ kind: "main" }, 28) : ""}</div><div><div class="txt">${text(m.content)}</div></div></div>`;
    last = m.role;
    return html;
  }).join("");
}

async function load(id) {
  V.loaded = id;
  try { V.messages = (await api("sessions/" + encodeURIComponent(id))).messages ?? []; } catch (error) { V.messages = []; toast(error.message); }
  V.id = id;
  render();
}

/* Wraps the conversation's scroll area in the split when another conversation is open beside it. */
export function besideWrap(scroll) {
  const id = S.beside15;
  if (!id || id === S.chat) return scroll;
  if (V.loaded !== id) load(id);
  const body = V.id === id ? thread(V.messages, id) : "";
  const name = esc(nameOf(id));
  return `<div class="split15">${scroll}<aside class="beside15" aria-label="${name}, beside"><div class="bs-h15">${av({ kind: "main" }, 26)}<span class="grow"><b>${name}</b><small></small></span><button class="btn ghost sm" type="button" data-act="chat" data-id="${esc(id)}">Open</button><button class="icon-btn" type="button" aria-label="Close the conversation beside" data-act="beside15" data-v="">${ic("x", "s")}</button></div><div class="bs-body15"><div class="thread">${body}</div></div></aside></div>`;
}

function beside(el) {
  if (el.dataset.v == null) { openPop($('[data-act="chatmenu"]') || el, besidePop(), { right: true, force: true }); return; }
  S.beside15 = el.dataset.v || null;
  V.loaded = null;
  closePop();
  render();
  if (S.beside15 && innerWidth < 1000) toast("Side by side needs a wider window. It opens when there is room.");
}

/* ---------- who it knows ---------- */
export const rosterButton = () => `<button class="icon-btn" type="button" aria-label="Who Branch knows and may talk to" data-tip="Who it knows" data-act="roster10h">${ic("users")}</button>`;

async function rosterPop() {
  const [mine, away] = await Promise.all([
    api("trunks").then((r) => ({ trunks: r.trunks ?? [] }), (error) => ({ error })),
    api("reach/trunks/remote", {}).then((r) => ({ computers: r.computers ?? [] }), (error) => ({ error })),
  ]);
  const own = (mine.trunks ?? []).find((t) => t.chatSessionId && t.chatSessionId === S.chat);
  const row = (key, name, sub, face) => `<div class="mi" role="menuitem">${face}<span><span class="mi-t">${esc(name)}</span><span class="mi-s">${esc(sub)}</span></span><input type="checkbox" class="sw" data-sw="knows" data-k="${esc(key)}" aria-label="${esc(own?.name ?? "Branch")} may talk to ${esc(name)}"></div>`;
  const here = (mine.trunks ?? []).filter((t) => !t.hidden && t.id !== own?.id).map((t) => row(t.id, t.name, t.title ?? "", av(t, 26))).join("")
    + (own ? row("branch", "Branch", "", av({ kind: "main" }, 26)) : "");
  const there = (away.computers ?? []).flatMap((c) => (c.trunks ?? []).map((t) => row(t.address ?? t.handle, t.name, [c.machine, t.title].filter(Boolean).join(" · "), av({ name: t.name }, 26)))).join("");
  const note = (r) => (r.error ? `<p class="hint" data-css="margin:4px 10px">${esc(r.error.message)}</p>` : "");
  return `<div class="ph">${esc(own?.name ?? "Branch")} knows and may talk to</div>${here}${note(mine)}<div class="ph">On other computers</div>${there}${note(away)}<hr>${mi("toast", "info", "Chains stop after 3 hops")}${mi("t9-kind-roster", "plug", "Connect another agent", "", 'data-v="agents"')}`;
}
async function roster(anchor, force) {
  if (!anchor) return;
  openPop(anchor, await rosterPop(), { right: true, force });
}

export function initBeside() {
  markLive(["beside15", "roster10", "roster10h"]);
  on("beside15", (el) => beside(el));
  on("roster10", () => roster($('[data-act="roster10h"]') || $('[data-act="chatmenu"]'), true));
  on("roster10h", (el) => roster(el, false));
}
