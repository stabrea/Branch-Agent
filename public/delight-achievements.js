/* phase2/delight: achievements in the window (off unless switched on). What is earned is worked out on
   this computer from what really happened (src/achievements.ts); this file only shows it. Bronze and
   Silver arrive as a small note at the top for about seven seconds; Gold and above as a card with a
   party of falling leaves that grows with the rank. "Keep things still" shows a still card instead. */
import { api } from "/app.js";
import { el, on, onDelight, say, state, still } from "/delight-kit.js";

const $ = (id) => document.getElementById(id);
export const TIERS = ["Bronze", "Silver", "Gold", "Diamond", "Godly", "SSS+"];
const tierClass = (tier) => `t-${String(tier).replace("+", "p").toLowerCase()}`;
const tierWord = (tier) => say(`delight.ach.tier.${tierClass(tier)}`, tier);
let latest = null, queue = [], showing = false, timer = 0;

/** A small round badge in the tier's colour with a leaf on it; greyed while locked. */
export function badge(tier, got, big = false) {
  const span = el("span", `ach-badge ${tierClass(tier)}${got ? "" : " locked"}${big ? " big" : ""}`);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3c5 2 7 6 7 10a7 7 0 01-14 0c0-4 2-8 7-10z"/><path d="M12 7v13"/></svg>';
  return span;
}
/** Asks what is earned now, and celebrates anything new once. */
export async function checkAchievements() {
  clearTimeout(timer);
  if (!on("achievements")) { latest = null; state.hints = []; return null; }
  // mac7/residuals: the achievements' own words come in the window's language (French or English).
  const language = document.documentElement.lang === "fr" ? "fr" : "en";
  try { latest = await api(`delight/achievements?lang=${language}`); } catch { return null; }
  if (!latest?.on) return latest;
  state.earned = latest.earned;
  state.rank = latest.rank;
  state.hints = latest.list.filter((a) => !a.got && (a.tier === "Bronze" || a.tier === "Silver"));
  const fresh = latest.fresh ?? [];
  if (fresh.length) {
    void api("delight/told", { ids: fresh.map((a) => a.id) }).catch(() => undefined);
    enqueue(fresh);
  }
  /* A long past is counted a batch at a time; while it is, look again soon (src/achievement-tallies.ts). */
  timer = setTimeout(checkAchievements, latest.behind ? 2000 : 5 * 60000);
  document.dispatchEvent(new CustomEvent("branch-achievements", { detail: latest }));
  return latest;
}
/** Many at once (switching on after a busy week): the best one is celebrated and the rest are counted. */
function enqueue(fresh) {
  const ranked = [...fresh].sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier));
  const shown = ranked.slice(0, 3);
  queue.push(...shown);
  if (ranked.length > shown.length) queue.push({ more: ranked.length - shown.length });
  if (!showing) next();
}
function next() {
  const item = queue.shift();
  showing = Boolean(item);
  if (!item) return;
  if (item.more) return note(null, say("delight.ach.more", "And {count} more. See them all in Settings › Appearance.", { count: item.more }), next);
  if (item.tier === "Bronze" || item.tier === "Silver") return note(item, null, next);
  party(item, next);
}

/* ---------- the small note at the top, about seven seconds ---------- */
export function note(item, words, done = () => undefined) {
  $("ach-note")?.remove();
  const box = el("div", "ach-note");
  box.id = "ach-note";
  box.setAttribute("role", "status");
  if (item) {
    const lines = el("div", "ach-lines");
    lines.append(el("small", "", say("delight.ach.earned", "{tier} achievement", { tier: tierWord(item.tier) })), el("b", "", item.name));
    box.append(badge(item.tier, true), lines);
  } else box.append(el("span", "ach-lines", words));
  const finish = () => { box.remove(); done(); };
  box.addEventListener("click", finish);
  document.body.append(box);
  underTopBar(box);
  setTimeout(() => box.classList.add("out"), 6600);
  setTimeout(() => { if (box.isConnected) finish(); }, 7200);
}
/** Just under the conversation's top bar, so none of its buttons is covered. */
function underTopBar(box) {
  const bar = document.querySelector("main > header")?.getBoundingClientRect();
  if (bar && bar.height && bar.bottom > 0) box.style.setProperty("top", `${Math.round(bar.bottom + 8)}px`);
}
/* ---------- the card and its party, for Gold and above ---------- */
const LEVEL = { Gold: 1, Diamond: 2, Godly: 3, "SSS+": 4 };
function confetti(level) {
  const bits = [];
  for (let i = 0; i < 16 * level; i++) {
    const bit = el("i", `bit c${i % 4}${i % 3 === 0 ? " leaf" : ""}`);
    bit.style.setProperty("--x", `${(i * 53) % 100}%`);
    bit.style.setProperty("--d", `${((i * 7) % 20) / 10}s`);
    bit.style.setProperty("--r", `${(i * 47) % 360}deg`);
    bits.push(bit);
  }
  return bits;
}
export function party(item, done = () => undefined) {
  document.querySelector(".ach-party")?.remove();
  const level = LEVEL[item.tier] ?? 1, calm = still();
  const layer = el("div", `ach-party lv${level}${calm ? " still" : ""}`);
  layer.setAttribute("role", "status");
  if (!calm) layer.append(...confetti(level));
  if (!calm && level >= 3) layer.prepend(el("div", "rays"));
  const card = el("div", "ach-card");
  const ok = el("button", "", say("delight.ach.lovely", "Lovely"));
  ok.type = "button";
  card.append(badge(item.tier, true, true), el("small", "", say("delight.ach.earned", "{tier} achievement", { tier: tierWord(item.tier) })),
    el("b", "", item.name), el("span", "", item.desc ?? ""), ok);
  layer.append(card);
  const finish = () => { if (!layer.isConnected) return; layer.remove(); done(); };
  ok.addEventListener("click", finish);
  document.body.append(layer);
  placeCard(card);
  setTimeout(finish, 9000);
}
/**
 * Over the conversation, never over the message box: above it when there is room, else under it. The card starts
 * where the sample's does, in the middle of the window (DG-077), and is only nudged from there, by its own layout
 * box, so the arrival animation's scale cannot skew the sums.
 */
function placeCard(card) {
  const main = document.querySelector("main")?.getBoundingClientRect(), box = $("chat-form")?.getBoundingClientRect();
  const left = card.offsetLeft, top = card.offsetTop, width = card.offsetWidth, height = card.offsetHeight;
  const dx = main && main.width ? Math.round(main.left + main.width / 2 - (left + width / 2)) : 0;
  let dy = 0;
  if (box && box.height && top + height + 12 > box.top) {
    const above = box.top - height - 12;
    dy = Math.round((above >= 8 ? above : box.bottom + 12) - top);
  }
  if (dx || dy) card.style.setProperty("translate", `${dx}px ${dy}px`);
}
/** "Try a celebration" in Settings: exactly what a real one looks like, and nothing is earned. */
export function preview(tier) {
  const item = { tier, name: say("delight.ach.previewName", "A preview"), desc: say("delight.ach.previewDesc", "This is how a {tier} achievement arrives. Nothing was earned.", { tier: tierWord(tier) }) };
  if (tier === "Bronze" || tier === "Silver") note(item, null); else party(item);
}

/* ---------- every achievement, in a sheet of its own ---------- */
/** "2026-09-19" as the window's language writes a date. */
const day = (iso) => {
  const at = new Date(`${iso}T12:00:00`);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(document.documentElement.lang || undefined, { dateStyle: "medium" });
};
const view = { tier: "all", query: "", more: false };
function card(a) {
  const tile = el("div", `ach${a.got ? " got" : ""}${a.name ? "" : " blank"}`);
  tile.append(badge(a.tier, Boolean(a.got)), el("b", "", a.name || " "), el("small", "tier-n", tierWord(a.tier)));
  if (a.desc) tile.append(el("small", "", a.desc));
  if (a.got) tile.append(el("span", "pill ok", say("delight.ach.gotOn", "Earned {date}", { date: day(a.got) })));
  else if (a.goal > 1 && a.now > 0) {
    const bar = el("div", "ach-bar"), fillBar = el("i");
    fillBar.style.setProperty("--done", `${Math.round((a.now / a.goal) * 100)}%`);
    bar.append(fillBar);
    tile.append(bar, el("small", "muted", say("delight.ach.progress", "{now} of {goal}", { now: a.now.toLocaleString(), goal: a.goal.toLocaleString() })));
  }
  if (!a.name) tile.setAttribute("aria-label", say("delight.ach.hidden", "A hidden {tier} achievement", { tier: tierWord(a.tier) }));
  return tile;
}
function chip(label, active, act) {
  const b = el("button", "secondary", label);
  b.type = "button";
  b.setAttribute("aria-pressed", String(active));
  b.addEventListener("click", () => {
    act();
    /* The chips were drawn again, so the keyboard goes to the new one with the same words. */
    [...document.querySelectorAll("#ach-sheet .ach-chips button")].find((x) => x.textContent === label)?.focus();
  });
  return b;
}
function paintSheet() {
  const body = $("ach-sheet-body");
  if (!body || !latest?.list) return;
  const q = view.query.trim().toLowerCase();
  const list = latest.list.filter((a) => (view.tier === "all" || a.tier === view.tier) && (!q || `${a.name} ${a.desc}`.toLowerCase().includes(q)));
  const chips = el("div", "ach-chips");
  chips.append(chip(say("delight.ach.allTiers", "Every tier"), view.tier === "all", () => { view.tier = "all"; paintSheet(); }));
  for (const tier of TIERS) chips.append(chip(tierWord(tier), view.tier === tier, () => { view.tier = tier; view.more = false; paintSheet(); }));
  const grid = el("div", "ach-grid");
  grid.append(...list.slice(0, view.more ? list.length : 60).map(card));
  body.replaceChildren(chips, grid);
  if (list.length > 60 && !view.more) {
    const more = chip(say("delight.ach.showAll", "Show all {count}", { count: list.length }), false, () => { view.more = true; paintSheet(); });
    more.classList.add("ach-more");
    body.append(more);
  }
  $("ach-sheet-count").textContent = say("delight.ach.count", "{earned} of {total} · rank {rank}", { earned: latest.earned, total: latest.total, rank: tierWord(latest.rank) });
}
export async function openSheet() {
  await checkAchievements();
  if (!latest?.on) return;
  $("ach-sheet")?.remove();
  const sheet = el("div", "ach-sheet");
  sheet.id = "ach-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", say("delight.ach.title", "Achievements"));
  const panel = el("div", "ach-panel"), head = el("div", "ach-head"), close = el("button", "secondary ach-close", say("delight.ach.close", "Close"));
  close.type = "button";
  close.addEventListener("click", () => sheet.remove());
  const search = el("input", "ach-search");
  search.type = "search";
  search.placeholder = say("delight.ach.search", "Search achievements");
  search.setAttribute("aria-label", search.placeholder);
  search.addEventListener("input", () => { view.query = search.value; paintSheet(); });
  head.append(el("h2", "", say("delight.ach.title", "Achievements")), Object.assign(el("span", "ach-count"), { id: "ach-sheet-count" }), close);
  panel.append(head, search, Object.assign(el("div", "ach-body"), { id: "ach-sheet-body" }));
  sheet.append(panel);
  sheet.addEventListener("click", (event) => { if (event.target === sheet) sheet.remove(); });
  document.body.append(sheet);
  paintSheet();
  close.focus();
}

/* Esc closes the sheet wherever the keyboard is, even after a chip redrew the part it was on. */
document.addEventListener("keydown", (event) => { if (event.key === "Escape") $("ach-sheet")?.remove(); });

let checkSoon = 0;
const soon = () => { clearTimeout(checkSoon); checkSoon = setTimeout(checkAchievements, 1500); };
document.addEventListener("branch-run-finished", soon);
document.addEventListener("branch-delight-noticed", soon);
onDelight(() => { if (on("achievements")) soon(); else { latest = null; state.hints = []; } });
globalThis.branchAchievements = { check: checkAchievements, preview, openSheet };
/* mac7/residuals: a new language asks again, so the achievements' own words follow it (an open list too). */
document.addEventListener("branch-language", () => void checkAchievements().then(() => paintSheet()));
