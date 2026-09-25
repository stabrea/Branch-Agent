/* "A change to Branch itself" in the thread (prototype selfCard): where a task in this conversation suggested a change to
   the gateway's settings (the gateway.propose tool) and that suggestion still waits (GET /api/never-break proposal), the
   card shows it under the reply that made it: the assistant's reason, each setting now and after, and whether the
   engine's throwaway try started cleanly. Apply is POST /api/never-break/proposal/accept, which saves it for the next
   start and says so in its own words; Not now is POST /api/never-break/proposal/discard. A suggestion whose try did not
   start cleanly can only be put away: the engine refuses to apply it, and the card says why in the engine's words. */

import { esc, render, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

const G = { view: null, asked: null };
const proposing = (m) => (m.toolCalls ?? []).some((call) => call.name === "gateway.propose");

/* The waiting suggestion is this call's own only if it carries the same reason and every setting the call asked for;
   the engine keeps one suggestion and not which conversation made it, so an older call never claims a newer one. */
function madeBy(m, p) {
  return (m.toolCalls ?? []).some((call) => {
    if (call.name !== "gateway.propose") return false;
    let args;
    try { args = JSON.parse(call.arguments || "{}"); } catch { return false; } // arguments that are not JSON asked for nothing
    const change = args?.change && typeof args.change === "object" ? args.change : {};
    return String(args?.why ?? "").trim() === p.why && Object.keys(change).every((k) => change[k] === p.config[k]);
  });
}

async function readGateway() {
  try { G.view = await api("never-break"); } catch (error) { toast(error.message); G.view = null; }
}

/* After a conversation is drawn: read the gateway only when this conversation suggested a change, once per suggestion. */
export async function loadSelfChange(sessionId, messages) {
  const last = messages.filter(proposing).at(-1);
  const key = last ? `${sessionId}:${last.messageId}` : null;
  if (!key || G.asked === key) return;
  G.asked = key;
  await readGateway();
  if (G.view?.proposal) render();
}

function changedRows(p, now) {
  return Object.keys(p.config).filter((k) => k !== "mode" && k !== "workerEnv" && p.config[k] !== now[k])
    .map((k) => `<tr><th>${esc(k)}</th><td>${esc(now[k])}</td><td><b>${esc(p.config[k])}</b></td></tr>`).join("");
}

/* The card, under the last reply of this conversation that made the waiting suggestion, while it waits. */
export function selfCard(m, messages) {
  const p = G.view?.proposal;
  if (!p || !madeBy(m, p) || messages.filter((x) => madeBy(x, p)).at(-1) !== m) return "";
  const ok = p.check?.ok === true;
  const pill = ok ? '<span class="pill ok ml"><i></i>Tried on a throwaway copy · started cleanly</span>' : "";
  const why = p.why ? `<div class="sub">${esc(p.why)}</div>` : "";
  const refused = ok || !p.check?.detail ? "" : `<p class="hint">${esc(p.check.detail)}</p>`;
  const apply = ok ? '<button class="btn pri sm" type="button" data-act="self-apply">Apply</button>' : "";
  return `<div class="b"><div class="gut"></div><div><div class="card self10"><div class="card-h"><b>${ic("gear", "s")}A change to Branch itself</b>${pill}</div>${why}
    <table class="cmp6"><thead><tr><th></th><th>Now</th><th>After</th></tr></thead><tbody>${changedRows(p, G.view.config ?? {})}</tbody></table>${refused}
    <p class="hint" data-css="margin:6px 0 0">Branch asks before changing how it’s set up. It can never change its own program or your saved work by itself.</p>
    <div class="acts">${apply}<button class="btn ghost sm" type="button" data-act="self-no">Not now</button></div></div></div></div>`;
}

async function answer(use) {
  try {
    const done = await api(use ? "never-break/proposal/accept" : "never-break/proposal/discard", {});
    if (use && done.note) toast(done.note);
  } catch (error) { toast(error.message); }
  await readGateway();
  renderNow();
}

export function initSelfChange() {
  markLive(["self-apply", "self-no"]);
  on("self-apply", () => answer(true));
  on("self-no", () => answer(false));
}
