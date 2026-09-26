/* Leave out of context (pass 17, design/redesign/pass17/FEATURES17C.md §3): a message stays in the conversation, faded
   (a dashed outline on your own), with "Left out of context · kept here, never sent to the model" and Put back under it;
   the engine never sends it to the model again (POST /api/sessions/<id>/left-out; GET /api/sessions/<id> marks it
   leftOut). The toast has Undo, and a pinned message is unpinned too, as the engine says. Only something you or the
   assistant said can be left out; a step that used tools cannot. */

import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, mi, toast, closePop } from "../core/ui.js";
import { ICONS } from "../core/icons.js";
import { markLive } from "../core/features.js";
import { addMoreItem } from "./more.js";

Object.assign(ICONS, { hide17c: '<path d="M3.5 12s3-6 8.5-6c1.6 0 3 .5 4.2 1.2M20.5 12s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2M4.5 19.5l15-15"/>' });

let X = { state: () => ({ sessionId: null, messages: [] }), reopen: async () => {} };
const LEFT = "Left out of context. It stays here for you; the model won’t see it from the next reply.";
const leavable = (m) => m.messageId && (m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length));

export const outClass = (m) => (m.leftOut ? " out17c" : "");
export const outBadge = (m) => (m.leftOut
  ? `<div class="outb17c ${m.role === "user" ? "me17c" : ""}">${ic("hide17c", "s")}<span>Left out of context · kept here, never sent to the model</span><button type="button" data-act="out17c" data-mid="${esc(m.messageId)}">Put back</button></div>` : "");

async function mark(sid, messageId, out) {
  const done = await api(`sessions/${encodeURIComponent(sid)}/left-out`, { messageId, out });
  await X.reopen(sid);
  return done;
}

async function flip(el) {
  closePop();
  const sid = X.state().sessionId, m = (X.state().messages ?? []).find((x) => String(x.messageId) === el.dataset.mid);
  if (!sid || !m) return;
  let done;
  try { done = await mark(sid, m.messageId, !m.leftOut); } catch (error) { toast(error.message); return; }
  if (!done.out) { toast("Back in context. The model sees it again from the next reply."); return; }
  const undo = () => mark(sid, m.messageId, false).catch((error) => toast(error.message));
  toast(done.unpinned ? `${LEFT} It was pinned, so it’s unpinned too.` : LEFT, undo);
}

export function initLeaveOut(context) {
  X = context;
  addMoreItem((m) => (leavable(m) ? mi("out17c", "hide17c", m.leftOut ? "Put back in context" : "Leave out of context", "", `data-mid="${esc(m.messageId)}"`) : ""));
  markLive(["out17c"]);
  on("out17c", (el) => flip(el));
}
