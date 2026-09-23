/* Redesign phase 1: the ring under the message box, the list behind it, and the question at 95%.
   The ring shows what the tightest connection has left, in the same honest states as Settings ›
   Data & usage › "What each connection has left": a share only where a service gave a limit and a
   remainder, never for money, and a plain "nothing reported" where nothing was. It is the owner's
   alone; anybody else's window is handed an empty answer by /api/usage/glance and shows nothing.
   At 95% used it may ask, for about five seconds, whether running tasks should write down where
   they are. It only asks: nothing happens unless "Save progress" is pressed. */
import { api, displayView, toast } from "/app.js";
import { t, formatDate } from "/i18n.js";
import { popover } from "/popover.js";
import { markTile } from "/brand-marks.js"; // phase2/accounts

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const ASKED = "branch-save-progress-asked";
const PROMPT_SECONDS = 5;
let glance = { available: false };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function svg(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
/** The ring itself: a full circle of what is left, dashed when nothing was reported or it is an estimate. */
function ring(percent, dashed, size = 20) {
  const r = 9, round = 2 * Math.PI * r;
  const box = svg("svg", { width: size, height: size, viewBox: "0 0 22 22", "aria-hidden": "true", class: "glance-ring" });
  box.append(svg("circle", { cx: 11, cy: 11, r, fill: "none", class: "glance-ring-track", "stroke-width": 3 }));
  const arc = svg("circle", { cx: 11, cy: 11, r, fill: "none", class: "glance-ring-arc", "stroke-width": 3,
    "stroke-linecap": "round", transform: "rotate(-90 11 11)" });
  if (dashed || percent === null) arc.setAttribute("stroke-dasharray", "2.5 2.5");
  else {
    arc.setAttribute("stroke-dasharray", String(round));
    arc.setAttribute("stroke-dashoffset", String(round * (1 - percent / 100)));
  }
  box.append(arc);
  return box;
}
const refillWords = (resetAt) => (resetAt ? t("glance.refills", { time: formatDate(resetAt, { timeStyle: "short" }) }) : "");

/** The words beside the ring: whose, how much is left, and when it refills. */
function ringWords(tightest) {
  if (!tightest) return t("glance.nothing");
  const name = tightest.accountLabel ? `${tightest.connectionName} — ${tightest.accountLabel}` : tightest.connectionName;
  const left = t(tightest.estimated ? "glance.leftEstimate" : "glance.left", { percent: tightest.percentLeft });
  return [name, left, refillWords(tightest.resetAt)].filter(Boolean).join(" · ");
}
function paintRing() {
  const bar = $("status-bar"), button = $("usage-ring");
  const show = glance.available && glance.settings?.ring !== "hidden";
  /* Until the first answer the row keeps its room without showing, so the box does not jump when it fills. */
  bar.dataset.state = "ready";
  bar.hidden = !show;
  if (!show) return;
  const tight = glance.tightest;
  const words = ringWords(tight);
  button.replaceChildren(ring(tight ? tight.percentLeft : null, !tight || tight.estimated), el("span", words, "glance-words"));
  button.dataset.low = String(Boolean(tight && tight.percentLeft < 15));
  button.setAttribute("aria-label", `${t("glance.title")}: ${words}`);
}

/* ---------- the list behind the ring ---------- */

const STATE_CHIP = { measured: ["glance.measured", "ok"], estimated: ["glance.estimate", "warn"], not_published: ["glance.notPublished", "idle"] };
/** phase2/accounts (#21, #31): the service's own mark (public/brand-marks.js), or a neutral tile. */
function tile(row) {
  const mark = markTile([row.connection, row.connectionName], { size: 26 });
  // After Batch 21: markTile may return empty fragments for branded marks; only add class if mark has one
  if (mark.classList) mark.classList.add("glance-tile");
  return mark;
}
function windowLine(window) {
  const line = el("div", undefined, "glance-window");
  line.append(el("span", window.title));
  const share = window.kind !== "money" && window.limit > 0 && window.remaining !== null
    ? Math.max(0, Math.min(100, (window.remaining / window.limit) * 100)) : null;
  if (share === null) {
    line.append(el("span", window.remaining === null ? t("glance.notSaid") : t("glance.leftOf", { left: window.remaining, of: window.limit ?? "?" }), "glance-figure"));
    return line;
  }
  const bar = el("span", undefined, `glance-bar${window.state === "estimated" ? " estimated" : ""}`);
  const fill = el("i");
  fill.style.width = `${share.toFixed(1)}%`;
  if (share < 15) fill.dataset.low = "true";
  bar.append(fill);
  const left = t(window.state === "estimated" ? "glance.leftEstimate" : "glance.left", { percent: Math.floor(share) });
  line.append(bar, el("span", [left, refillWords(window.resetAt)].filter(Boolean).join(" · "), "glance-figure"));
  return line;
}
function rowNode(row) {
  const node = el("div", undefined, "glance-row");
  const body = el("div", undefined, "glance-row-body");
  const head = el("div", undefined, "glance-row-head");
  head.append(el("b", row.connectionName));
  if (row.accountLabel) head.append(el("span", row.accountLabel, "glance-muted"));
  const local = row.windows.length === 0 && row.note && /on this computer/i.test(row.note);
  const [key, tone] = local ? ["glance.local", "idle"] : STATE_CHIP[row.state] ?? STATE_CHIP.not_published;
  head.append(el("span", t(key), `glance-chip ${tone}`));
  if (row.accountLabel && row.inUse) head.append(el("span", t("glance.usedNext"), "glance-chip ok"));
  body.append(head);
  for (const window of row.windows) body.append(windowLine(window));
  if (row.note) body.append(el("small", row.note));
  node.append(tile(row), body);
  return node;
}
function paintPopover() {
  const box = $("usage-pop");
  box.replaceChildren(el("p", t("glance.title"), "glance-heading"));
  for (const row of glance.rows ?? []) box.append(rowNode(row));
  box.append(el("p", glance.empty ? glance.summary : `${glance.summary} ${t("glance.neverAdded")}`, "glance-summary"));
  const foot = el("div", undefined, "glance-foot");
  const open = el("button", t("glance.openUsage"));
  open.type = "button";
  open.addEventListener("click", () => { $("usage-pop").hidden = true; $("usage-ring").setAttribute("aria-expanded", "false"); displayView("usage"); });
  foot.append(open);
  box.append(foot);
}

/* ---------- the question at 95% ---------- */

function askedKeys() {
  try { return JSON.parse(localStorage.getItem(ASKED) || "[]"); } catch { return []; }
}
function rememberAsked(key) {
  try { localStorage.setItem(ASKED, JSON.stringify([key, ...askedKeys().filter((one) => one !== key)].slice(0, 50))); }
  catch { /* a private window asks again next time */ }
}
/** The first crossing not yet asked about, when asking is on and something is running. */
export function nextCrossing(state, asked) {
  if (!state.available || state.settings?.saveProgress !== "ask" || !state.running) return null;
  return (state.crossings ?? []).find((crossing) => !asked.includes(crossing.key)) ?? null;
}
function closePrompt() {
  const box = $("save-progress");
  if (box) box.remove();
}
async function saveNow() {
  closePrompt();
  try {
    const { asked } = await api("usage/save-progress", {});
    toast(asked === 1 ? t("glance.saveSentOne") : asked ? t("glance.saveSent", { count: asked }) : t("glance.saveNone"));
  } catch (error) { toast(error.message); }
}
function promptBox(crossing) {
  const box = el("div", undefined, "save-progress");
  box.id = "save-progress";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-labelledby", "save-progress-words");
  const count = el("span", String(PROMPT_SECONDS), "save-progress-count");
  const clock = el("span", undefined, "save-progress-clock");
  clock.append(ring(100, false, 30), count);
  const words = el("div", undefined, "save-progress-words");
  words.id = "save-progress-words";
  words.append(el("b", t("glance.almostOut", { name: crossing.connectionName })), el("small", t("glance.almostOutNote", { percent: crossing.percentUsed })));
  const save = el("button", t("glance.save"));
  save.type = "button";
  save.addEventListener("click", () => void saveNow());
  const later = el("button", t("glance.notNow"), "quiet-button");
  later.type = "button";
  later.addEventListener("click", closePrompt);
  box.append(clock, words, save, later);
  return box;
}
function showPrompt(crossing) {
  rememberAsked(crossing.key);
  closePrompt();
  const box = promptBox(crossing);
  document.body.append(box);
  const started = Date.now(), total = PROMPT_SECONDS * 1000;
  const arc = box.querySelector(".glance-ring-arc"), round = 2 * Math.PI * 9;
  const tick = () => {
    if (!box.isConnected) return;
    const left = Math.max(0, total - (Date.now() - started));
    arc.setAttribute("stroke-dashoffset", String(round * (1 - left / total)));
    box.querySelector(".save-progress-count").textContent = String(Math.ceil(left / 1000));
    if (left <= 0 && !box.contains(document.activeElement)) box.remove();
    else setTimeout(tick, 200);
  };
  tick();
}

/* ---------- keeping it fresh ---------- */

let timer = null;
export async function refreshGlance() {
  clearTimeout(timer);
  if ($("workspace")?.hidden !== false || !sessionStorage.getItem("branch-token")) { timer = setTimeout(refreshGlance, 5000); return; }
  try { glance = await api("usage/glance"); } catch { glance = { available: false }; }
  if (!$("status-bar")) return;
  paintRing();
  if (!$("usage-pop").hidden) paintPopover();
  const crossing = nextCrossing(glance, askedKeys());
  if (crossing && !document.hidden) showPrompt(crossing);
  timer = setTimeout(refreshGlance, glance.running ? 20000 : 60000);
}
/**
 * Integration review: the list opens where it covers nothing you are typing into: under the ring when
 * there is room there, otherwise above the message box rather than over it. Only a window too short for
 * either (a phone held sideways) lets it sit over the box, as before.
 */
function placePopover() {
  const pop = $("usage-pop"), bar = $("status-bar"), form = $("chat-form");
  pop.style.top = pop.style.bottom = "";
  if (!bar || !form) return;
  const barBox = bar.getBoundingClientRect(), formBox = form.getBoundingClientRect(), height = pop.offsetHeight;
  if (innerHeight - barBox.bottom - 16 >= height) { pop.style.top = "calc(100% + 8px)"; pop.style.bottom = "auto"; return; }
  if (formBox.bottom <= barBox.top + 1 && formBox.top - 16 >= height) pop.style.bottom = `${barBox.bottom - formBox.top + 8}px`;
}
popover($("usage-ring"), $("usage-pop"), { onOpen: () => paintPopover(), afterOpen: () => placePopover() });
document.addEventListener("branch-run-finished", () => void refreshGlance());
document.addEventListener("branch-profile", () => void refreshGlance());
document.addEventListener("branch-usage-glance", () => void refreshGlance());
document.addEventListener("branch-language", () => paintRing());
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshGlance(); });
/* In the full window the line under the box is already there, so the ring joins it before the cost instead
   of adding a row of its own; in the calm window, where that line is hidden, it sits just under it. */
function placeBar() {
  const bar = $("status-bar"), foot = document.querySelector(".composer-foot");
  if (!bar || !foot) return;
  const full = document.documentElement.dataset.everything === "on";
  if (full && bar.parentElement !== foot) foot.insertBefore(bar, $("conversation-cost"));
  if (!full && bar.parentElement === foot) foot.after(bar);
}
new MutationObserver(placeBar).observe(document.documentElement, { attributes: true, attributeFilter: ["data-everything"] });
placeBar();
/* The first look happens as soon as the window is unlocked, not on the next tick of the timer. */
new MutationObserver(() => { if ($("workspace")?.hidden === false) void refreshGlance(); })
  .observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
void refreshGlance();
globalThis.branchUsageGlance = { refresh: refreshGlance };
