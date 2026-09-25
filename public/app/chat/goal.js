/* Goal mode in the conversation (design doc 4.3): the strip at the top of a conversation working toward a goal, from
   GET /api/sessions/<id>/goal (its objective, round, the judge's score and what is still missing, time spent), with
   Pause, Resume and Stop through POST /api/sessions/<id>/goal {action}. "Set a goal" in the + menu puts the engine's
   /goal command in the message box; nothing starts until it is sent. */

import { $, esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";

const goals = new Map();
/* A conversation whose goal could not be read is said once, not on every redraw. */
const failed = new Set();

/* Only a goal that is working or paused has a strip; a finished one is said in the conversation itself. */
export function goalStrip(sessionId) {
  const g = sessionId ? goals.get(sessionId) : null;
  if (!g || (g.status !== "working" && g.status !== "paused")) return "";
  const score = typeof g.score === "number" ? g.score : null;
  const facts = [`Round ${g.round} of ${g.maxRounds}`, score === null ? "" : `score ${score.toFixed(1)} of 1`,
    g.missing?.length ? `still missing: ${g.missing.join("; ")}` : "", `${Math.round((g.elapsedMs ?? 0) / 60000)} min`].filter(Boolean);
  const button = g.status === "working"
    ? `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="pause" data-id="${esc(sessionId)}">Pause</button>`
    : `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="resume" data-id="${esc(sessionId)}">Resume</button>`;
  return `<div class="goal6">${ic("target", "s")}<span class="grow"><b>Goal: ${esc(g.objective)}</b><small>${esc(facts.join(" · "))}</small><span class="meter6"><u data-css="width:${(score ?? 0) * 100}%"></u></span></span>${button}<button class="btn ghost sm" type="button" data-act="goal-st" data-v="stop" data-id="${esc(sessionId)}">Stop</button></div>`;
}

/* After a conversation is drawn: re-read its goal, and draw again only if it changed. */
export async function loadGoal(sessionId) {
  if (!sessionId || failed.has(sessionId)) return;
  let goal;
  try { goal = (await api(`sessions/${encodeURIComponent(sessionId)}/goal`)).goal; } catch (error) { failed.add(sessionId); toast(error.message); return; }
  if (JSON.stringify(goal) !== JSON.stringify(goals.get(sessionId) ?? null)) { goals.set(sessionId, goal); renderNow(); }
}

export function initGoal() {
  markLive(["goal-st", "goal-fill"]);
  on("goal-st", async (el) => {
    const id = el.dataset.id;
    try { goals.set(id, (await api(`sessions/${encodeURIComponent(id)}/goal`, { action: el.dataset.v })).goal); } catch (error) { toast(error.message); }
    renderNow();
  });
  on("goal-fill", () => {
    closePop();
    const box = $("#prompt");
    if (!box) return;
    box.value = "/goal ";
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
