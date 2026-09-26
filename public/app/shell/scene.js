/* What lives behind the glass and at the foot of the list, 1:1 with the prototype's: a painted scene behind the window
   when the engine's background is on (GET/POST /api/delight/settings keeps on, scrim and fit), and the pet walking along
   the list when the engine's pet is on. Which painted scene, the season and where the pet walks are the window's own
   (FEATURE-AUDIT: scene-set, season, petwhere15), kept in this browser; your own file is shell/ownbg.js. A pat, and
   following the computer's light or dark (shell/look.js), are told to the engine (POST /api/delight/noticed, which
   counts them when achievements are on). */

import { $, esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { effMode } from "./look.js";
import { OWN, loadOwn } from "./ownbg.js";

const KEY = "branch-scene";
export const W = { bg: "painted", scene: "auto", season: "auto", petWhere: "side" };
export const D = { settings: null, earned: null, asked: false };

/* The painted scenes: the four groves and the night from /art, and the extra scenes in /art/bg. */
export const SCENES = [["auto", "By the season", ""], ["spring", "Spring grove", "/art/grove-spring.webp"], ["autumn", "Autumn grove", "/art/grove-autumn.webp"],
  ["winter", "Winter grove", "/art/grove-winter.webp"], ["night", "Firefly night", "/art/grove-night.webp"], ["summer", "Summer Meadow", "/art/bg/grove-summer.webp"],
  ["rain", "Rainy Forest", "/art/bg/grove-rain.webp"], ["lake", "Mountain Lake", "/art/bg/grove-lake.webp"], ["blossom", "Blossoming Grove", "/art/bg/grove-blossom.webp"],
  ["canyon", "Desert Canyon", "/art/bg/grove-canyon.webp"], ["snownight", "Snowy Night", "/art/bg/grove-snownight.webp"], ["bamboo", "Bamboo Grove", "/art/bg/grove-bamboo.webp"],
  ["hills", "Sunflower Hills", "/art/bg/grove-hills.webp"]];
const PAINT = { spring: "spring", summer: "spring", autumn: "autumn", winter: "winter" };
const seasonNow = () => (W.season !== "auto" ? W.season : ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"][new Date().getMonth()]);
function paintFile() {
  const picked = SCENES.find((s) => s[0] === W.scene);
  if (picked?.[2]) return picked[2];
  return `/art/grove-${effMode() === "dark" ? "night" : PAINT[seasonNow()] || "spring"}.webp`;
}

export function saveWindow() {
  try { localStorage.setItem(KEY, JSON.stringify(W)); } catch (error) { toast(error.message); }
}
function loadWindow() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (error) { toast(error.message); }
  if (["painted", "none", "own"].includes(saved?.bg)) W.bg = saved.bg;
  if (SCENES.some((s) => s[0] === saved?.scene)) W.scene = saved.scene;
  if (["auto", "spring", "autumn", "winter"].includes(saved?.season)) W.season = saved.season;
  if (["side", "status"].includes(saved?.petWhere)) W.petWhere = saved.petWhere;
}

/* The engine's delight switches, read once the window is let in and after every change. */
let seenState = null;
export async function loadDelight() {
  if (D.asked || !E.loaded) return;
  D.asked = true;
  seenState = E.state;
  loadWindow();
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; } catch (error) { toast(error.message); }
  try { await loadOwn(); } catch (error) { toast(error.message); }
}
/* Read again after each refresh (the engine's events refresh the window), so a switch changed elsewhere, such as in
   the terminal, reaches an open window. Redraws only when the switches changed. */
let reading = null;
export function followDelight() {
  if (!D.asked || !E.state || E.state === seenState) return reading ?? Promise.resolve();
  seenState = E.state;
  reading = rereadDelight().finally(() => { reading = null; });
  return reading;
}
async function rereadDelight() {
  const before = JSON.stringify(D.settings);
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; } catch (error) { toast(error.message); }
  if (JSON.stringify(D.settings) !== before) render();
}
/* Changes only the parts named; the engine merges each part into what it has. */
export async function saveDelight(part) {
  try { D.settings = (await api("delight/settings", part)).settings; } catch (error) { toast(error.message); }
}

/* What "Behind the glass" has chosen: none while the engine's switch is off, else the painted grove or your own. */
export const bgChoice = () => (D.settings?.background?.on ? W.bg : "none");
export const showsBackground = () => bgChoice() === "painted" || (bgChoice() === "own" && !!OWN.url);
const calm = () => !!E.state?.preferences?.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Your own file: a video plays muted in a loop (paused while things are kept still); a picture or an animation fills,
   fits or repeats as the engine's fit says. */
function drawOwn(layer, fit) {
  const { saved } = OWN;
  if (saved.kind === "video") {
    const v = Object.assign(document.createElement("video"), { src: OWN.url, muted: true, loop: true, playsInline: true, autoplay: !calm() });
    v.className = `bg-media fit-${fit === "fit" ? "fit" : "fill"}`;
    layer.prepend(v);
    return;
  }
  const d = Object.assign(document.createElement("div"), { className: `bg-media bg-img fit-${fit}` });
  d.style.backgroundImage = `url("${OWN.url}")`;
  layer.prepend(d);
}

/* The layer behind the window: made once, redrawn only when what it shows changes. */
let layerKey = "";
export function drawBackground() {
  const app = document.getElementById("app");
  let layer = $("#bgLayer");
  const on = showsBackground();
  app.classList.toggle("has-bg", on);
  if (!on) { layer?.remove(); layerKey = ""; return; }
  if (!layer) { layer = Object.assign(document.createElement("div"), { id: "bgLayer" }); app.prepend(layer); layerKey = ""; }
  layer.style.setProperty("--scrim", (D.settings.background.scrim ?? 60) / 100);
  const own = bgChoice() === "own", fit = D.settings.background.fit ?? "fill";
  const key = own ? `own|${OWN.url}|${fit}|${calm()}` : paintFile() + "|" + calm();
  if (key === layerKey) return;
  layerKey = key;
  if (own) { layer.innerHTML = '<div class="bg-scrim"></div>'; drawOwn(layer, fit); return; }
  layer.innerHTML = `<div class="paint11 ${calm() ? "" : "drift11"}"></div><div class="bg-scrim"></div>`;
  layer.firstElementChild.style.backgroundImage = `url("${paintFile()}")`;
}

/* ---------- the pet ---------- */
const PETS = {
  squirrel: { name: "Squirrel", px: ["............", ".......oo...", "......oooo..", "..o..ooeooo.", ".ooo.ooooob.", ".oooooooooo.", "..oooobbooo.", "...oooobbo..", "...oo..oo...", "............"], col: { o: "#B8652B", b: "#F2D0AE", e: "#1B1A18" } },
  owl: { name: "Owl", px: ["............", "...o....o...", "...oooooo...", "..owwowwoo..", "..oweoweoo..", "..oooyyooo..", "..obbbbbbo..", "..obbbbbbo..", "...oo..oo...", "............"], col: { o: "#6E5A45", w: "#F4EDE0", e: "#1B1A18", y: "#E0A33B", b: "#A38B6C" } },
  hedgehog: { name: "Hedgehog", px: ["............", "...s.s.s....", "..sssssss...", ".sssssssss..", ".ssssssssfe.", ".sssssssffff", "..ffffffff..", "...f.ff.f...", "............", "............"], col: { s: "#5B4A3B", f: "#D9B48F", e: "#1B1A18" } },
};
const P = { x: 0, dir: 1, frame: 0, say: "", until: 0, cool: 0 };
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
export function petShown() { const p = D.settings?.pets; return !!(p?.on && PETS[p.kind] && !hidden("pet")); }

/* The pet's markup, drawn inside the list's foot or the status bar by whichever region W.petWhere names. */
export function petHTML(where) {
  if (!petShown() || W.petWhere !== where) return "";
  const p = D.settings.pets, speaking = P.say && Date.now() < P.until;
  const box = `<div class="petbox ${P.dir < 0 ? "flip" : ""}" data-hide="pet" ${where === "side" ? `data-css="left:${8 + P.x}px"` : ""}><span class="pet-say" id="pet-say" ${speaking ? "" : "hidden"}>${esc(P.say)}</span><canvas id="pet-cv" width="24" height="20" role="button" tabindex="0" aria-label="${esc(p.name)} the ${esc(PETS[p.kind].name.toLowerCase())}. Click for a tip." data-act="pat"></canvas></div>`;
  return where === "side" ? `<div class="keeper">${box}</div>` : box;
}
export function drawPet() {
  syncWalker();
  document.body.classList.toggle("pet-status15", petShown() && W.petWhere === "status");
  const cv = $("#pet-cv"), p = PETS[D.settings?.pets?.kind];
  if (!cv || !p) return;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, 24, 20);
  p.px.forEach((row, y) => [...row].forEach((ch, x) => { const c = p.col[ch]; if (!c) return; g.fillStyle = c; g.fillRect(x * 2, y * 2 - (P.frame % 2 && y > 7 ? 1 : 0), 2, 2); }));
}

/* What the pet says: a Trunk that needs a yes first, else a tip that is true of this window. */
function petWords() {
  const waiting = (E.state?.attention ?? [])[0];
  if (waiting) return `${waiting.who || "Branch"} needs a yes. It’s in your Inbox.`;
  return ["Ctrl K finds anything, even settings.", "Hover anything to see what it does."][Math.floor(Date.now() / 60000) % 2];
}
function say(text) {
  P.say = text;
  P.until = Date.now() + 6500;
  const el = $("#pet-say");
  if (el) { el.textContent = text; el.hidden = false; }
}
/* Something the window saw, told to the engine (POST /api/delight/noticed, the shapes in src/delight.ts NoticeSchema).
   The engine keeps it only while achievements are on, so nothing is sent while they are off. */
export async function noticed(what) {
  if (!D.settings?.achievements?.on) return;
  try { await api("delight/noticed", what); } catch (error) { toast(error.message); }
}
export async function pat() {
  say(petWords());
  await noticed({ what: "pat" });
}

/* It walks, unless things are kept still; it speaks up by itself when a Trunk needs you, at most every five minutes.
   The timer runs only while the pet is shown. */
let walker = null;
function syncWalker() {
  const want = petShown();
  if (want && !walker) walker = setInterval(walk, 360);
  else if (!want && walker) { clearInterval(walker); walker = null; }
}
function walk() {
  const box = $(".petbox");
  if (!box || calm()) return;
  P.frame++;
  const max = Math.max(8, (box.parentElement?.clientWidth ?? 120) - 56);
  P.x += P.dir * 6;
  if (P.x + 8 > max) P.dir = -1;
  if (P.x < 0) { P.x = 0; P.dir = 1; }
  if (W.petWhere === "side") box.style.left = 8 + P.x + "px";
  box.classList.toggle("flip", P.dir < 0);
  drawPet();
  const bubble = $("#pet-say");
  if (bubble && !bubble.hidden && Date.now() > P.until) bubble.hidden = true;
  if (Date.now() > P.cool && bubble?.hidden && (E.state?.attention ?? []).length) { P.cool = Date.now() + 300000; say(petWords()); }
}
