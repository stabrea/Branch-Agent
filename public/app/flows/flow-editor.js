/* A procedure as a picture (the prototype's flow editor), opened from Automations › Procedures. The rows there are the
   engine's saved recipes (GET /api/state `procedures`: each record's data.definition has a name and steps of a tool and
   its arguments), so this draws those real steps, read-only. Changing steps, adding one, moving one, running the recipe
   from here and the last-run track stay greyed: the engine has no route that saves edited steps, and running a recipe
   calls its tools directly, which is not started from the window. */

import { esc } from "../core/dom.js";
import { openDlg, ic } from "../core/ui.js";
import { E } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const stepsOf = (record) => (Array.isArray(record?.data?.definition?.steps) ? record.data.definition.steps : []);
const argsText = (args) => { const text = JSON.stringify(args ?? {}); return text === "{}" ? "" : text.length > 160 ? text.slice(0, 159) + "…" : text; };

/* The prototype's picture: one box per step, joined top to bottom. Every recipe step is a tool call, so every box is drawn
   the same way; its words are the tool's name. */
function flowSVG(steps) {
  const W = 560, cx = W / 2, bh = 38, gap = 24, parts = [];
  let y = 10;
  const cut = (t, w) => { const n = Math.floor(w / 7.2); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  steps.forEach((s, i) => {
    parts.push(`<rect x="${cx - 160}" y="${y}" width="320" height="${bh}" rx="10" fill="var(--raise)" stroke="var(--line-2)" stroke-width="1.5"/><text x="${cx}" y="${y + bh / 2 + 4}" text-anchor="middle">${esc(cut(String(s.tool ?? ""), 304))}</text>`);
    y += bh;
    if (i < steps.length - 1) { parts.push(`<path d="M${cx} ${y} C ${cx} ${y + gap / 2}, ${cx} ${y + gap / 2}, ${cx} ${y + gap}" stroke="var(--ink-3)" stroke-width="1.5" fill="none" marker-end="url(#fa)"/>`); y += gap; }
  });
  return `<svg class="flow-svg" viewBox="0 0 ${W} ${y + 10}" role="img" aria-label="The procedure as a picture"><defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>${parts.join("")}</svg>`;
}

function flowRow(s, j, n) {
  const words = [s.tool, argsText(s.args)].filter(Boolean).join(" ");
  return `<div class="flow-row"><input class="inp" id="ft-${j}" value="${esc(words)}" readonly aria-label="Step ${j + 1}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1" ${j === 0 ? "disabled" : ""}>Move up</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1" ${j === n - 1 ? "disabled" : ""}>Move down</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}">Take it out</button></span></div>`;
}

function openFlow(id) {
  const record = (E.state?.procedures ?? []).find((p) => p.id === id);
  if (!record) return;
  const steps = stepsOf(record);
  openDlg({ title: String(record.data?.definition?.name ?? ""), wide: true,
    body: `<div id="flow-pic">${flowSVG(steps)}</div><div>${steps.map((s, j) => flowRow(s, j, steps.length)).join("")}</div><div class="acts"><button class="btn" type="button" data-act="flow-add">${ic("plus", "s")}Add a step</button><span class="tb-grow"></span><button class="btn" type="button" data-act="flow-run">${ic("play", "s")}Run</button><button class="btn pri" type="button" data-act="flow-save">Save</button></div>` });
}

export function init() {
  markLive(["flow"]);
  on("flow", (el) => openFlow(el.dataset.id));
}
