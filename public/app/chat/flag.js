/* Flag this reply (FEATURE-AUDIT `flag`, the prototype's pass 17): one or more reasons and a note, kept by the engine on
   this computer against that one reply (POST /api/reply-flags; the engine reads the reply's words itself). A flagged
   reply shows its flag under it with Remove (POST /api/reply-flags/{id}/remove), and its flag button is pressed; both are
   read from GET /api/reply-flags. Sending a flag to the Branch team has no engine route, so "Also send to the Branch
   team" and "Open that setting" stay greyed: nothing leaves this computer. */

import { $, esc, render } from "../core/dom.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const REASONS = [["wrong", "Wrong or made up"], ["ignored", "Didn’t do what I asked"], ["unasked", "Did something I didn’t ask for"],
  ["unsafe", "Unsafe or rude"], ["unclear", "Too long or unclear"], ["other", "Something else"]];
const F = { list: [], reply: null, pick: new Set() };
const words = (keys) => keys.map((k) => REASONS.find(([id]) => id === k)?.[1] ?? k).join(", ");

export const flagOf = (sessionId, messageId) => F.list.find((f) => f.sessionId === sessionId && f.messageId === messageId);

/* The line under a flagged reply. */
export function flagBadge(sessionId, m) {
  const f = m.messageId ? flagOf(sessionId, m.messageId) : null;
  return f ? `<div class="flb17c">${ic("flag", "s")}<span>Flagged: ${esc(words(f.reasons))} · kept on this computer</span><button type="button" data-act="flrm17c" data-v="${esc(f.id)}">Remove</button></div>` : "";
}

export async function loadFlags() {
  let list;
  try { list = (await api("reply-flags")).flags ?? []; } catch (error) { toast(error.message); return; }
  const changed = JSON.stringify(list) !== JSON.stringify(F.list);
  F.list = list;
  if (changed) render();
}

const sendRow = () => `<div class="flsend17c off17c"><input type="checkbox" class="sw" id="fl-send17c" aria-label="Also send to the Branch team"><span class="grow"><b>Also send to the Branch team</b><small>Off. You can allow it in Settings › Data &amp; usage.</small></span><button class="link" type="button" data-act="flgo17c">Open that setting</button></div>`;

function openFlag(el) {
  F.reply = { sessionId: el.dataset.sid, messageId: Number(el.dataset.mid) };
  F.pick = new Set();
  const said = (el.closest("[data-i15]")?.querySelector(".txt")?.textContent ?? "").trim().slice(0, 70);
  const chips = REASONS.map(([k, r]) => `<button type="button" class="chip6" data-act="flr17c" data-v="${k}" aria-pressed="false">${esc(r)}</button>`).join("");
  openDlg({ title: "Flag this reply",
    body: `<p class="lede" data-css="margin:0 0 10px">What went wrong with “${esc(said)}”? The flag is kept on this computer with the reply, so you can look back at it.</p><div class="flr17c" role="group" aria-label="What went wrong">${chips}</div><div class="field"><label for="fl-note17c">A note (optional)</label><textarea class="inp" id="fl-note17c" rows="3" placeholder="What should it have done?"></textarea></div>${sendRow()}`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="flsave17c">Keep the flag</button>' });
}

function pick(el) {
  const k = el.dataset.v, had = F.pick.has(k);
  if (had) F.pick.delete(k); else F.pick.add(k);
  el.setAttribute("aria-pressed", String(!had));
}

async function save() {
  if (!F.pick.size) { toast("Pick at least one reason."); return; }
  try {
    const kept = await api("reply-flags", { ...F.reply, reasons: [...F.pick], note: $("#fl-note17c")?.value ?? "" });
    closeDlg();
    toast(kept.said);
  } catch (error) { toast(error.message); }
  await loadFlags();
}

async function remove(el) {
  try { toast((await api(`reply-flags/${encodeURIComponent(el.dataset.v)}/remove`, {})).said); } catch (error) { toast(error.message); }
  await loadFlags();
}

export function initFlag() {
  markLive(["flag", "flr17c", "flsave17c", "flrm17c", "sw:fl-note17c"]);
  on("flag", (el) => openFlag(el));
  on("flr17c", (el) => pick(el));
  on("flsave17c", () => save());
  on("flrm17c", (el) => remove(el));
}
