/* Settings › Data & usage, pass 17 (prototype patch17b), from the engine:
   Move in: GET /api/move-in?look=1 lists the five assistants and whether each was found on this computer; picking
   one reads POST /api/move-in/preview { source } (what would come, nothing changes); Bring it in is
   POST /api/move-in/import { source, items } with every item that is neither blocked nor already brought over.
   With the switch off the engine refuses the preview in its own words, which are shown.
   Take everything with you: GET /api/agent-export counts each part; Export is POST /api/agent-export { sections }
   and saves the one file (memory always leaves with personal details masked; keys never go in). Trunks and
   conversations are not parts of that file, so they are drawn and not ticked. Spend caps and the rows below them
   have no window route yet (greyed). */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, $ } from "../core/ui.js";
import { demos17, row17, sec17, pill17 } from "./rows17.js";

const U = { sources: [], pick: null, preview: null, moved: null, parts: null };

export function sections17(lv) {
  let html = sec17("Moving in and out",
    row17("Move in from another assistant", U.moved ? `Brought in from ${U.moved}. Everything came in as a copy.` : "Conversations, memory, instructions, skills and tool servers from Claude Code, Codex, Hermes Agent, OpenClaw or OpenCode.", "Move in…", "moveinb17")
    + row17("Take everything with you", "Your Trunks, skills, procedures, memory and settings as one file. Keys never go in it.", "Export…", "exportb17"));
  if (lv >= 1) html += sec17("Money and keeping, more",
    row17("Spend caps per service", "A monthly limit for each service that bills per use; work pauses and asks when one is reached.", "Set caps", "capsb17")
    + demos17(["balance", "projcost", "backup", "retention", "held"]));
  return html;
}

/* ---------- move in ---------- */
const bringable = () => (U.preview?.groups ?? []).flatMap((g) => g.items).filter((i) => !i.blocked && !i.alreadyMoved).map((i) => i.key);
function moveDlg() {
  const opts = U.sources.map((s) => `<button type="button" class="upd-o15" data-act="moveinpickb17" data-v="${esc(s.source)}" aria-pressed="${U.pick === s.source}" ${s.found ? "" : "disabled"}><b>${esc(s.name)}</b><small>${s.found ? "Found on this computer" : "Not found here"}</small></button>`).join("");
  const rows = U.preview ? `<div class="rows">${U.preview.groups.map((g) => `<div class="prow"><span class="grow"><b>${esc(g.name)}</b><small>${esc(g.items.filter((i) => !i.blocked).length)}</small></span>${pill17("ok", "Comes in")}</div>`).join("")}<div class="prow"><span class="grow"><b>Keys and passwords</b><small>Never copied; you sign in again where needed</small></span>${pill17("idle", "Left out")}</div></div>`
    : '<p class="hint" data-css="margin:0">Pick one to see what comes in.</p>';
  openDlg({ title: "Move in from another assistant", body: `<p class="lead-b17">Branch looked on this computer. Everything comes in as a copy; the other assistant keeps working.</p><div class="opts-b17">${opts}</div>${rows}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="moveingob17" ${bringable().length ? "" : "disabled"}>Bring it in</button>` });
}
async function openMove() {
  try {
    const found = await api("move-in?look=1");
    // Off looks at nothing; the engine says why in its own words when asked for a preview.
    if (found.mode === "off") await api("move-in/preview", { source: "claude-code" });
    Object.assign(U, { sources: found.sources ?? [], pick: null, preview: null });
  } catch (error) { toast(error.message); return; }
  moveDlg();
}
async function pick(el) {
  U.pick = el.dataset.v;
  try { U.preview = await api("move-in/preview", { source: U.pick }); } catch (error) { U.preview = null; toast(error.message); }
  moveDlg();
}
async function bring() {
  const items = bringable();
  if (!U.pick || !items.length) return;
  try { U.moved = (await api("move-in/import", { source: U.pick, items })).name; } catch (error) { toast(error.message); return; }
  closeDlg();
  render();
}

/* ---------- take everything with you ---------- */
const summary = (names) => (U.parts ?? []).filter((p) => names.includes(p.name)).map((p) => p.summary).join(" · ");
/* The dialog's ticks: each names the parts of the file it stands for. */
const EXP = [["#exp-b17-skills", ["skills", "procedures"]], ["#exp-b17-memory", ["memory"]], ["#exp-b17-settings", ["routing", "permissions"]]];
function exportDlg() {
  const tick = (id, title, sub, on, live = true) => `<label class="prow"><input type="checkbox" class="chk15" ${live ? `id="${id}"` : "disabled"} ${on ? "checked" : ""}><span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
  const body = tick("", "Trunks and their instructions", "", false, false)
    + tick("exp-b17-skills", "Skills and procedures", summary(["skills", "procedures"]), true)
    + tick("exp-b17-memory", "Memory", "Personal details removed", true)
    + tick("exp-b17-settings", "Settings", summary(["routing", "permissions"]), true)
    + tick("", "Conversations", "", false, false);
  openDlg({ title: "Take everything with you", body: `<p class="lead-b17">One .branch file another Branch can open. Keys, passwords and sign-ins never go in it.</p><div class="rows">${body}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="exportgob17">Export</button>' });
}
async function openExport() {
  try { U.parts = (await api("agent-export")).sections; } catch (error) { toast(error.message); return; }
  exportDlg();
}
async function exportNow() {
  const sections = EXP.filter(([sel]) => $(sel)?.checked).flatMap(([, parts]) => parts);
  if (!sections.length) return;
  try {
    const { data } = await api("agent-export", { sections });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `branch-${new Date().toISOString().slice(0, 10)}.branch` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDlg();
  } catch (error) { toast(error.message); }
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  on("moveinb17", () => openMove());
  on("moveinpickb17", (el) => pick(el));
  on("moveingob17", () => bring());
  on("exportb17", () => openExport());
  on("exportgob17", () => exportNow());
  markLive(["moveinb17", "moveinpickb17", "moveingob17", "exportb17", "exportgob17", "sw:exp-b17-skills", "sw:exp-b17-memory", "sw:exp-b17-settings"]);
}
