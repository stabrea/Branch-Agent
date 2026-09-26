/* Words to a schedule, confirmed (the prototype's proposal card under Automations › Scheduled "Describe it").
   The engine reads the sentence (POST /api/schedules/propose {text}): what to do, when it repeats, and when it first
   runs. Every change on the card is read again by the engine ({edit}), so the first run and the cron line are always
   the engine's. Nothing is saved until "Confirm the schedule", which is the ordinary POST /api/schedules. "Who does it"
   stays greyed: a schedule the owner adds runs as the owner, and the engine has no field for another Trunk. */

import { $, esc, renderNow } from "../core/dom.js";
import { E, refresh, level } from "../core/state.js";
import { ic, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";

const DAYN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let P = null; // { proposal, what, days, day, time }

/* The engine's schedule on the card's own terms: repeats, which day, and the time (null when the words said none). */
function fromProposal(proposal, what) {
  const s = proposal.schedule, w = (s.weekdays ?? []).join();
  const days = s.intervalMs ? null : s.monthDay ? "monthly" : w === "1,2,3,4,5" ? "weekdays" : w === "0,6" ? "weekends" : s.weekdays?.length === 1 ? "weekly" : s.weekdays ? null : "daily";
  return { proposal, what: what ?? s.prompt, days, day: s.weekdays?.length === 1 ? s.weekdays[0] : null, time: proposal.time === "none" ? null : s.dailyAt ?? null };
}
const hm = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
function whenWords(p) {
  const monthDay = p.proposal.schedule.monthDay;
  if (!p.days || (p.days === "monthly" && monthDay !== 1)) return p.proposal.words;
  const head = { weekdays: "Weekdays", weekends: "Weekends", monthly: "The 1st of each month", weekly: cap1(DAYN[p.day] ?? "") + "s", daily: "Every day" }[p.days];
  return `${head} at ${hm(p.time)}`;
}
function firstRun(iso) {
  const d = new Date(iso), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86_400_000);
  const name = days === 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "long" });
  return `${name}, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
/* "Every so often" has no day or time on the card; it is ready as the engine read it, until a Repeats button is pressed. */
const everySoOften = (p) => !p.days && !!p.proposal.schedule.intervalMs;
const ready = (p) => everySoOften(p) || (!!p.days && !!p.time);

const seg = (k, v, label, pressed) => `<button type="button" data-act="ppset17d" data-k="${k}" data-v="${v}" aria-pressed="${pressed}">${label}</button>`;
function whoField() {
  const off = ' disabled aria-disabled="true" data-tip="Coming soon"';
  return `<div class="fld"><span>Who does it</span><span class="seg">${(Array.isArray(E.trunks) ? E.trunks : []).slice(0, 5).map((t) => `<button type="button" class="soon" aria-pressed="false"${off}>${esc(t.name)}</button>`).join("")}</span></div>`;
}

/* The card under the box, while a proposal is open. */
export function propCard() {
  const p = P;
  if (!p) return "";
  const repeats = [["daily", "Every day"], ["weekdays", "Weekdays"], ["weekends", "Weekends"], ["weekly", "Once a week"], ["monthly", "Monthly"]].map(([v, l]) => seg("days", v, l, p.days === v)).join("");
  const on = p.days === "weekly" ? `<div class="fld"><span>On</span><span class="seg">${DAYN.map((d, i) => seg("day", i, cap1(d.slice(0, 3)), p.day === i)).join("")}</span></div>` : "";
  const need = !everySoOften(p) && !p.time;
  const first = ready(p) ? `<b>${esc(whenWords(p))}</b> · first run ${esc(firstRun(p.proposal.firstRunAt))}` : "Pick a time to see when it first runs.";
  const cron = level() >= 2 && p.proposal.cron ? `<code class="pp-cron17d">cron ${esc(p.proposal.cron)} · ${esc(p.proposal.schedule.timezone)}</code>` : "";
  return `<div class="prop17d" role="region" aria-label="Proposed schedule"><div class="pp-h17d">${ic("clock", "s")}<b>Here’s the schedule Branch understood</b><span class="pill idle"><i></i>Not saved yet</span></div>
    <label class="fld"><span>It does</span><input class="inp" id="pp-what17d" value="${esc(p.what)}"></label>
    <div class="fld"><span>Repeats</span><span class="seg" role="group" aria-label="Repeats">${repeats}</span></div>${on}
    <div class="pp-g17d"><label class="fld ${need ? "need17d" : ""}"><span>At${need ? " · it didn’t say when" : ""}</span><input class="inp" type="time" id="pp-time17d" value="${esc(p.time ?? "")}"></label>${whoField()}</div>
    <p class="pp-first17d" id="pp-first17d">${first}${p.proposal.time === "guessed" ? " · Branch guessed part of this; check it." : ""}</p>${cron}
    <div class="acts"><button class="btn ghost sm" type="button" data-act="ppno17d">Cancel</button><button class="btn pri sm" type="button" data-act="ppok17d" ${ready(p) ? "" : "disabled"}>Confirm the schedule</button></div>
    <p class="hint" data-css="margin:0">It runs only after you confirm. Until then nothing is saved.</p></div>`;
}

const keepWhat = () => { const w = document.getElementById("pp-what17d"); if (P && w) P.what = w.value; };

/* The box's words, read by the engine; its refusal is shown in its own words. */
export async function proposeWords() {
  const text = $("#nl-in")?.value.trim();
  if (!text) return;
  try { P = fromProposal((await api("schedules/propose", { text, timezone: zone() })).proposal); } catch (error) { toast(error.message); return; }
  renderNow();
  document.getElementById("pp-what17d")?.focus();
}

/* A change on the card, read again by the engine so the first run is its own. Without a time yet, only the card moves. */
async function reread() {
  keepWhat();
  const p = P;
  if (!p.days || !p.time) return renderNow();
  const weekdays = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], weekly: [p.day ?? 5] }[p.days];
  const edit = { prompt: p.what.trim() || p.proposal.schedule.prompt, dailyAt: p.time, ...(weekdays ? { weekdays } : {}), ...(p.days === "monthly" ? { monthDay: p.proposal.schedule.monthDay ?? 1 } : {}) };
  try { P = fromProposal((await api("schedules/propose", { edit, timezone: p.proposal.schedule.timezone })).proposal, p.what); } catch (error) { toast(error.message); }
  renderNow();
}

async function confirm() {
  keepWhat();
  const p = P;
  if (!p || !ready(p)) return;
  try { await api("schedules", { ...p.proposal.schedule, prompt: p.what.trim() || p.proposal.schedule.prompt }); } catch (error) { toast(error.message); return; }
  P = null;
  const box = $("#nl-in");
  if (box) box.value = "";
  await refresh().catch((error) => toast(error.message));
  renderNow();
  toast(`Scheduled. First run: ${firstRun(p.proposal.firstRunAt)}.`);
}

export function initScheduleCard() {
  markLive(["nl-add", "sw:nl-in", "ppset17d", "ppno17d", "ppok17d", "sw:pp-what17d", "sw:pp-time17d"]);
  on("nl-add", () => proposeWords());
  on("ppset17d", (el) => {
    if (!P) return;
    const k = el.dataset.k;
    P[k] = k === "day" ? +el.dataset.v : el.dataset.v;
    if (k === "days" && el.dataset.v === "weekly" && P.day == null) P.day = 5;
    reread();
  });
  on("ppno17d", () => { P = null; renderNow(); toast("Nothing was saved."); });
  on("ppok17d", () => confirm());
  document.addEventListener("change", (e) => {
    if (e.target.id !== "pp-time17d" || !P || !e.target.value) return;
    P.time = e.target.value;
    P.days ??= "daily";
    reread();
  });
}
