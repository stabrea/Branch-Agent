/* phase2/settings: Appearance laid out to be looked at (owner critiques #5, #24, #25, #38, #39).

   Beside the themes, two small live mirrors of your own window, side by side: one dark, one light,
   both wearing the theme you have (or the one under the pointer). Each mirror is a copy of the window
   as it is now, drawn in a separate blank frame so nothing in it can be pressed, found by id or seen
   by the app's own watchers; it is copied again at most once a second while Appearance is open.
   The tiles' words (Default, High contrast, Easy in daylight) are the sample's, drawn in layout.js. The eye
   beside Day or night clears the view to show the background. Nothing here changes a setting by itself. */
import { t } from "/i18n.js";
import { solid, surfaceOf, themeById, tokensFor, wearTokens } from "/theme-bridge.js";
import { seasonToday } from "/grove.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
const MODES = [["dark"], ["light"]];
let previewing = null;

/* ---------- the mirrors ---------- */
/* DG-039: the sample's live preview (its `mirrorsHTML`, which replaces the preview inside its later `lookHTML`):
   two live mirrors of this window, Moonlight then Daylight, each with a small chip. Wide, they stack beside the
   choices; narrower, a strip names the theme and opens them side by side; on a phone one shows at a time, with a
   button to flip to the other. */
const modeNow = () => (root.dataset.theme === "daylight" ? "light" : "dark");
const lightWord = (mode) => (mode === "dark" ? say("look.moonlight", "Moonlight") : say("look.daylight", "Daylight"));
function seasonWord() {
  let season = null;
  try { season = localStorage.getItem("branch-season"); } catch { /* a private window forgets */ }
  season ||= seasonToday();
  return say(`look.season.${season}`, season).toLowerCase();
}
function mirrorFrame(mode) {
  const figure = document.createElement("figure");
  figure.className = "sg-mirror";
  figure.dataset.mode = mode;
  const box = document.createElement("div");
  box.className = "sg-mirror-box";
  const frame = document.createElement("iframe");
  frame.className = "sg-mirror-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.inert = true;
  frame.title = "";
  box.append(frame);
  const chip = document.createElement("figcaption");
  chip.className = "sg-mirror-caption";
  chip.textContent = lightWord(mode);
  figure.append(box, chip);
  return figure;
}
/** The sample's `swap` icon, as the small button beside it draws it. */
function swapIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4");
  svg.append(path);
  return svg;
}
/** On a phone one mirror shows at a time; this shows the other. */
function flipButton(pair) {
  const flip = document.createElement("button");
  flip.type = "button";
  flip.className = "sg-mirror-flip";
  const words = document.createElement("span");
  const word = () => say("look.show", "Show {light}").replace("{light}", lightWord(pair.dataset.show === "light" ? "dark" : "light"));
  words.textContent = word();
  flip.append(swapIcon(), words);
  flip.addEventListener("click", () => {
    pair.dataset.show = pair.dataset.show === "light" ? "dark" : "light";
    words.textContent = word();
    stale = true;
    drawMirrors();
  });
  return flip;
}
/** The strip the sample shows on a narrow window: a picture of the theme, its name, its light and season. */
function previewStrip(aside) {
  const strip = document.createElement("button");
  strip.type = "button";
  strip.className = "sg-strip";
  strip.setAttribute("aria-expanded", "false");
  strip.setAttribute("aria-controls", "sg-mirror-pair");
  const thumb = document.createElement("span");
  thumb.className = "sg-strip-thumb";
  thumb.setAttribute("aria-hidden", "true");
  thumb.append(document.createElement("u"), document.createElement("i"));
  const words = document.createElement("span");
  words.className = "sg-strip-name";
  words.append(document.createElement("b"), document.createElement("small"));
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 9l6 6 6-6");
  chevron.append(path);
  strip.append(thumb, words, chevron);
  strip.addEventListener("click", () => {
    const open = !aside.classList.contains("sg-open");
    aside.classList.toggle("sg-open", open);
    strip.setAttribute("aria-expanded", String(open));
    stale = true;
    drawMirrors();
  });
  return strip;
}
function drawStrip(family) {
  const strip = document.querySelector(".sg-strip");
  if (!strip) return;
  const mode = modeNow(), theme = themeById(family), tokens = tokensFor(theme, mode);
  const thumb = strip.querySelector(".sg-strip-thumb");
  thumb.style.background = tokens["--ground"];
  thumb.querySelector("u").style.background = mode === "dark" ? solid(tokens["--ground"], "#000000", 0.4) : solid(tokens["--text"], tokens["--ground"], 0.08);
  thumb.querySelector("i").style.background = surfaceOf(tokens, mode);
  strip.querySelector("b").textContent = family === chosen() ? theme[1] : say("look.previewing", "{name} (preview)").replace("{name}", theme[1]);
  strip.querySelector("small").textContent = `${lightWord(mode)} · ${seasonWord()}`;
}
function buildMirrors() {
  const aside = document.createElement("aside");
  aside.className = "sg-mirrors";
  aside.id = "sg-mirrors";
  aside.dataset.tLabel = "settingsGrown.look.preview";
  aside.setAttribute("aria-label", say("settingsGrown.look.preview", "Preview"));
  const wrap = document.createElement("div");
  wrap.className = "sg-mirrors-wrap";
  wrap.id = "sg-mirror-pair";
  const pair = document.createElement("div");
  pair.className = "sg-mirror-pair";
  pair.dataset.show = "dark";
  pair.append(...MODES.map(([mode]) => mirrorFrame(mode)));
  wrap.append(pair, flipButton(pair));
  aside.append(previewStrip(aside), wrap);
  return aside;
}
/** A blank frame of the same size as the window, with the same stylesheets, ready for a copy. */
function prepare(frame) {
  const doc = frame.contentDocument;
  if (!doc || doc.body?.dataset.ready) return doc;
  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const copy = doc.createElement("link");
    copy.rel = "stylesheet";
    copy.href = link.href;
    doc.head.append(copy);
  }
  doc.body.dataset.ready = "1";
  return doc;
}
/* Pictures already on screen, kept as data: the server answers every file "no-store", so a copy that named
   them again would fetch them again at every redraw (integration review). */
const pictures = new Map();
function pictureOf(img) {
  if (pictures.has(img.src)) return pictures.get(img.src);
  if (!img.complete || !img.naturalWidth) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    pictures.set(img.src, canvas.toDataURL());
  } catch { pictures.set(img.src, null); }
  return pictures.get(img.src);
}
/** Each copied picture shows the one on screen, or nothing; never a second request for it. */
function keepPictures(pane, copy) {
  const originals = pane.querySelectorAll("img"), copies = copy.querySelectorAll("img");
  copies.forEach((img, at) => {
    const data = originals[at] ? pictureOf(originals[at]) : null;
    img.removeAttribute("srcset");
    if (data) img.src = data; else img.removeAttribute("src");
  });
}
/**
 * The window's panes as they are now, without hidden parts or anything that runs. The copy keeps its ids
 * so the same rules dress it; it lives in the frame's own document, where no id or name can clash. It is
 * cloned here, where a picture on screen is already loaded, and only moved into the frame once its
 * pictures are data, so the frame never asks the server for one.
 */
function copyPanes(doc) {
  const panes = [...document.querySelectorAll("body > .rail, body > main, body > .context-panel")].filter((pane) => pane.checkVisibility());
  return panes.map((pane) => {
    const copy = pane.cloneNode(true);
    keepPictures(pane, copy);
    for (const node of [...copy.querySelectorAll("[hidden], script, iframe, video, audio, canvas, dialog")]) node.remove();
    for (const field of copy.querySelectorAll("input, textarea, button, select")) field.disabled = true;
    return doc.adoptNode(copy);
  });
}
/** Dresses a mirror in a theme for its own light or dark. */
function dress(doc, mode, family) {
  const html = doc.documentElement;
  for (const { name, value } of root.attributes) if (name.startsWith("data-")) html.setAttribute(name, value);
  html.dataset.theme = mode === "light" ? "daylight" : "forest";
  const contrast = $("lx-contrast")?.checked ? "more" : "standard";
  const theme = themeById(family), tokens = tokensFor(theme, mode, contrast);
  wearTokens(html, theme, tokens);
  html.style.setProperty("--surface", surfaceOf(tokens, mode)); // the window's own blend, so the mirror shows what the window will
  doc.body.className = document.body.className.replace(/\blx-settings-open\b/g, "");
}
function drawMirror(figure, family) {
  const frame = figure.querySelector("iframe"), doc = prepare(frame);
  if (!doc) return;
  const width = innerWidth, height = innerHeight, box = figure.querySelector(".sg-mirror-box");
  const scale = box.clientWidth / width, tallest = parseFloat(getComputedStyle(box).maxHeight) || Infinity;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${scale})`;
  box.style.height = `${Math.round(Math.min(height * scale, tallest))}px`;
  dress(doc, figure.dataset.mode, family);
  doc.body.replaceChildren(...copyPanes(doc));
}
/** Only a new look: the copy stays, the colours change (for a tile under the pointer). */
function redress(family) {
  for (const figure of document.querySelectorAll(".sg-mirror")) {
    const doc = figure.querySelector("iframe").contentDocument;
    if (!doc?.body?.dataset.ready) continue;
    dress(doc, figure.dataset.mode, family);
  }
  drawStrip(family);
}
const chosen = () => root.dataset.palette || "slate";
let showing = false, timer = null, stale = true;
function drawMirrors() {
  timer = null;
  if (!showing) { stale = true; return; }
  stale = false;
  for (const figure of document.querySelectorAll(".sg-mirror")) drawMirror(figure, previewing ?? chosen());
  drawStrip(previewing ?? chosen());
}
/** At most once a second, and only while the mirrors are on screen. */
function soon() {
  stale = true;
  if (!timer && showing) timer = setTimeout(drawMirrors, 1000);
}

/* ---------- the theme row: pointing at a tile shows it; the eye clears the view (#39) ---------- */
function watchTiles(gallery) {
  const point = (event) => {
    const tile = event.target.closest?.(".lx-tile");
    const next = tile?.dataset.family ?? null;
    if (next === previewing) return;
    previewing = next;
    redress(previewing ?? chosen());
  };
  gallery.addEventListener("pointerover", point);
  gallery.addEventListener("focusin", point);
  gallery.addEventListener("pointerleave", () => { previewing = null; redress(chosen()); });
  gallery.addEventListener("focusout", (event) => { if (!gallery.contains(event.relatedTarget)) { previewing = null; redress(chosen()); } });
}
function clearViewButton() {
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "sg-clear-view";
  eye.id = "sg-clear-view";
  eye.dataset.tTitle = "settingsGrown.look.clear";
  eye.title = say(eye.dataset.tTitle, "Clear the view: see the background. Click anywhere or press Escape to come back.");
  eye.setAttribute("aria-label", eye.title);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z");
  svg.append(path);
  eye.append(svg);
  eye.addEventListener("click", () => {
    document.querySelector(".lx-settings-close")?.click();
    $("lx-clear")?.click();
  });
  return eye;
}

function start() {
  const block = document.querySelector("#lx-page-appearance > .lx-look");
  const gallery = $("lx-theme-gallery");
  if (!block || !gallery) return;
  block.classList.add("sg-look");
  const mirrors = buildMirrors();
  block.prepend(mirrors);
  $("lx-mode")?.after(clearViewButton());
  watchTiles(gallery);
  new IntersectionObserver((entries) => {
    showing = entries.some((entry) => entry.isIntersecting);
    if (showing && stale) drawMirrors();
  }).observe(mirrors);
  for (const pane of document.querySelectorAll("body > .rail, body > main, body > .context-panel"))
    new MutationObserver(soon).observe(pane, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
  new MutationObserver(() => { previewing = null; soon(); }).observe(root, { attributes: true, attributeFilter: ["data-palette", "data-theme", "style"] });
  addEventListener("resize", soon);
  document.addEventListener("branch-language", () => {
    for (const chip of document.querySelectorAll(".sg-mirror-caption")) chip.textContent = lightWord(chip.parentElement.dataset.mode);
    const pair = document.querySelector(".sg-mirror-pair"), flip = document.querySelector(".sg-mirror-flip");
    if (pair && flip) flip.querySelector("span").textContent = say("look.show", "Show {light}").replace("{light}", lightWord(pair.dataset.show === "light" ? "dark" : "light"));
    stale = true;
    soon();
  });
}
if (document.body.classList.contains("lx-ready")) start();
else new MutationObserver((_, observer) => {
  if (!document.body.classList.contains("lx-ready")) return;
  observer.disconnect();
  start();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
