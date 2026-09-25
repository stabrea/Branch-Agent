/* The side panel's Terminal tab (design doc 4.6, the prototype's terminalPane): each command the conversation's tasks ran,
   with what came back, read from the engine's GET /api/panels/work?session=<id> (src/panels-work.ts). The same answer
   carries the browser's pages and the last picture it took, which the full-size view (stage.js) shows.
   "Open a terminal for me" stays greyed: running a command from the window is for separate security review. */

import { esc, render } from "../core/dom.js";
import { ic, toast } from "../core/ui.js";
import { api } from "../core/api.js";

const W = { sid: null, work: null, at: 0, loading: false, said: "" };

/* What the engine said for this conversation, or null before the first answer. */
export const work = (sid) => (sid && sid === W.sid ? W.work : null);

/* Reads the conversation's work again at most every two seconds; the window is drawn again when the answer changes. */
export async function loadWork(sid) {
  if (!sid || W.loading || (sid === W.sid && Date.now() - W.at < 2000)) return;
  W.loading = true;
  W.at = Date.now();
  try {
    const next = await api(`panels/work?session=${encodeURIComponent(sid)}`);
    const same = sid === W.sid && JSON.stringify(next) === JSON.stringify(W.work);
    Object.assign(W, { sid, work: next, said: "" });
    if (!same) render();
  } catch (error) {
    if (sid !== W.sid) Object.assign(W, { sid, work: null });
    // Said once, not again every two seconds while the engine keeps refusing for the same reason.
    if (error.message !== W.said) toast(error.message);
    W.said = error.message;
  } finally {
    W.loading = false;
  }
}

/* The engine's own states, drawn as the Activity tab draws them: a tick, a cross, or a spinner. Only a command waiting on
   a yes has words of its own in the prototype. */
const MARK = { done: "check", practice: "check", failed: "x", refused: "x", stopped: "x", running: "spin" };

function row(entry) {
  const pill = entry.state === "waiting" ? '<span class="pill warn">Waiting for your yes</span>' : ic(MARK[entry.state] ?? "info", entry.state === "running" ? "s spin" : "s");
  const out = entry.output ? `<pre>${esc(entry.output)}</pre>` : "";
  return `<div class="termrow"><div class="th2"><code>$ ${esc(entry.what)}</code>${pill}</div>${out}</div>`;
}

export function terminalBody(sid) {
  const entries = work(sid)?.terminal?.entries ?? [];
  const rows = entries.map(row).join("") || '<p class="empty">No commands in this conversation yet. Commands a Trunk runs, and what came back, show here.</p>';
  return `<div class="term7">${rows}<div class="acts"><button class="btn sm" type="button" data-act="shell" data-v="open">Open a terminal for me</button></div></div>`;
}
