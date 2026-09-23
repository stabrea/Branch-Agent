/* phase2/shell: one way of drawing a face, for Trunks, computers and people, wherever they show —
   the strip, the studio, the sidebar roster, the People page and the replies (critiques #7, #18).

   A face is a shape (a mask) filled with a series colour, with its content on top: the drawn face
   made from the name, letters, an emoji, pixel art made from the name, a photo, or a computer's
   picture. A status ring follows the shape. No colour is written here: every colour is a token
   (--series-N, --copper, --good, --warn, --faint, --ground), so each theme draws faces its own way,
   except a colour the owner chose for a Trunk (DG-105: kept as a value), drawn with the token ink that stays readable on it.
   A 3D stand-in (critique #46) is drawn in CSS only while "3D faces" is switched on. */

const SVG = "http://www.w3.org/2000/svg";
export const SHAPES = {
  circle: "M50 2a48 48 0 1 0 .01 0Z",
  squircle: "M50 2C88 2 98 12 98 50S88 98 50 98 2 88 2 50 12 2 50 2Z",
  leaf: "M50 2C84 22 98 54 74 86 66 94 58 98 50 98 42 98 34 94 26 86 2 54 16 22 50 2Z",
  acorn: "M50 5C74 5 95 17 95 37 95 42 90 45 84 45 84 72 70 92 50 98 30 92 16 72 16 45 10 45 5 42 5 37 5 17 26 5 50 5Z",
  shield: "M50 3 92 17V48C92 73 75 90 50 98 25 90 8 73 8 48V17Z",
  hexagon: "M50 2 92 26V74L50 98 8 74V26Z",
  pebble: "M54 4C82 6 98 28 95 56 92 84 68 98 43 96 17 94 2 72 5 45 8 18 26 2 54 4Z",
  screen: "M22 6H78C88 6 94 12 94 22V78C94 88 88 94 78 94H22C12 94 6 88 6 78V22C6 12 12 6 22 6Z",
  tall: "M34 2H66C74 2 80 8 80 16V84C80 92 74 98 66 98H34C26 98 20 92 20 84V16C20 8 26 2 34 2Z",
};
export const TRUNK_SHAPES = ["circle", "squircle", "leaf", "acorn", "shield", "hexagon", "pebble"];
export const MOTIONS = ["none", "breathe", "sway", "shimmer", "pulse", "dots"];
export const GLYPHS = {
  laptop: "M5 6h14v9H5zM3 18h18", desktop: "M3 4h18v12H3zM9 20h6M12 16v4", server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2",
};
const masks = new Map();
export function maskOf(shape) {
  if (!masks.has(shape)) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'><path d='${SHAPES[shape] ?? SHAPES.circle}'/></svg>`;
    masks.set(shape, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  }
  return masks.get(shape);
}
export function hash(text) {
  let value = 2166136261;
  for (const char of String(text || "trunk").trim().toLowerCase()) value = Math.imul(value ^ char.codePointAt(0), 16777619) >>> 0;
  return value;
}
export const initialsOf = (name) => (String(name || "").trim().split(/\s+/).map((word) => [...word][0] ?? "").join("").slice(0, 2) || "?").toUpperCase();
const HEX = /^#[0-9a-f]{6}$/i;
const colourVar = (colour) => (colour === "theme" ? "var(--copper)" : HEX.test(String(colour)) ? colour : `var(--series-${colour})`);
/** WCAG relative luminance of a colour written as six hex digits. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The sample's white ink on a chosen colour, or black where white would not reach 4.5:1 (black then reaches at least 4.6:1). */
export function inkOn(hex) {
  return 1.05 / (luminance(hex) + 0.05) >= 4.5 ? "var(--face-ink-light)" : "var(--face-ink-dark)";
}

/** DG-105: the colour a Trunk is drawn in: its look's token, else the colour picked as a value, else null (its name's). */
export function trunkColour(trunk) {
  const token = trunk.look?.colour ?? null;
  return token === null && HEX.test(String(trunk.chosenColour ?? "")) ? trunk.chosenColour : token;
}

/* ---------- what a Trunk's look comes to, the name's own choices filling the gaps ---------- */
export function trunkSpec(trunk) {
  const seed = hash(trunk.avatar?.seed || trunk.name), look = trunk.look ?? {};
  const photo = trunk.avatar && trunk.avatar.kind !== "face" ? trunk.avatar.dataUrl : null;
  return {
    kind: "trunk", name: trunk.name, seed,
    face: photo ? "photo" : look.face ?? "drawn", photo, letters: look.letters || initialsOf(trunk.name), emoji: look.emoji || "",
    shuffle: look.shuffle ?? 0, colour: colourVar(trunkColour(trunk) ?? ((seed >>> 9) % 8) + 1),
    shape: look.shape ?? (seed % 4 % 2 ? "squircle" : "circle"), motion: look.motion ?? "none", depth: look.depth ?? "flat",
  };
}
export function computerSpec(device) {
  const phone = device.platform === "ios" || device.platform === "android";
  return { kind: phone ? "phone" : "computer", name: device.name, seed: hash(device.id || device.name), face: "glyph",
    glyph: phone ? "phone" : device.here ? "laptop" : "desktop", colour: colourVar((hash(device.id || device.name) % 8) + 1),
    shape: phone ? "tall" : "screen", motion: "none", depth: "flat" };
}
/** The assistant on this computer, or a specialist, drawn from its name: its own look on every reply. */
export function assistantSpec(name) {
  const seed = hash(`${name}@assistant`);
  return { kind: "assistant", name, seed, face: "drawn", colour: colourVar(((seed >>> 9) % 8) + 1), shape: "squircle", motion: "none", depth: "flat" };
}
export function personSpec(person) {
  return { kind: "person", name: person.name, seed: hash(person.name), face: "letters", letters: initialsOf(person.name),
    colour: colourVar((hash(person.name) % 8) + 1), shape: "circle", motion: "none", depth: "flat" };
}

/* ---------- the content inside the shape ---------- */
function node(tag, attributes = {}) {
  const made = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  return made;
}
/** The face drawn from the name: two eyes and a mouth in the ground colour. */
function drawnFace(seed) {
  const svg = node("svg", { viewBox: "0 0 32 32", class: "fc-drawn", "aria-hidden": "true" });
  const eyes = (seed >>> 3) % 4, mouth = (seed >>> 6) % 4;
  for (const x of [11, 21]) svg.append(eyes % 2 ? node("circle", { cx: x, cy: 13, r: 1.5 + eyes / 2 }) : node("rect", { x: x - 2, y: 12, width: 4, height: 2 + eyes, rx: 1 }));
  const curve = ["M11 20 Q16 24 21 20", "M11 21 H21", "M12 20 Q16 23 20 20 Q16 22 12 20", "M13 21 Q16 19 19 21"][mouth];
  svg.append(node("path", { d: curve, class: "fc-mouth" }));
  return svg;
}
function glyphFace(glyph) {
  const svg = node("svg", { viewBox: "0 0 24 24", class: "fc-glyph", "aria-hidden": "true" });
  svg.append(node("path", { d: GLYPHS[glyph] ?? GLYPHS.laptop }));
  return svg;
}
/* Letters and emoji are drawn by CSS from data-text, so a button holding a face still counts as a
   button with no words of its own and gets the glass hover help (public/glass-select.js). */
function textFace(text, className) {
  const span = document.createElement("span");
  span.className = className;
  span.dataset.text = text;
  return span;
}
function imageFace(src, className) {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = src;
  return img;
}
function content(spec, box) {
  if (spec.face === "photo" && spec.photo) return imageFace(spec.photo, "fc-photo");
  if (spec.face === "emoji" && spec.emoji) return textFace(spec.emoji, "fc-emoji");
  if (spec.face === "letters") return textFace(spec.letters || initialsOf(spec.name), "fc-letters");
  if (spec.face === "glyph") return glyphFace(spec.glyph);
  if (spec.face === "pattern") return patternFace(spec, box);
  return drawnFace(spec.seed);
}

/* ---------- pixel art made from the name, dithered like the acorn ---------- */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function channelsOf(element) {
  const numbers = (getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? ["128", "128", "128"]).slice(0, 3).map(Number);
  return numbers.length === 3 ? numbers : [128, 128, 128];
}
function paintPattern(canvas, seed, base) {
  const size = 12, g = canvas.getContext("2d"), image = g.createImageData(size, size);
  const mix = (to, k) => base.map((v, i) => Math.round(v + (to[i] - v) * k));
  const palette = [mix([0, 0, 0], 0.55), mix([0, 0, 0], 0.2), base, mix([255, 255, 255], 0.5)];
  let state = seed || 7;
  const next = () => ((state = Math.imul(state ^ (state >>> 15), 2246822519) ^ Math.imul(state ^ (state >>> 13), 3266489917)) >>> 0) / 4294967296;
  const cells = Array.from({ length: size * size / 2 }, next);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mirrored = x < size / 2 ? x : size - 1 - x, light = (1 - y / (size - 1)) * 0.45 + cells[y * (size / 2) + mirrored] * 0.75;
    const level = light * 3, floor = Math.floor(level), up = level - floor > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? 1 : 0;
    image.data.set([...palette[Math.min(3, floor + up)], 255], (y * size + x) * 4);
  }
  g.putImageData(image, 0, 0);
}
function patternFace(spec, box) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 12;
  canvas.className = "fc-pattern";
  canvas.dataset.seed = String(hash(`${spec.seed}:${spec.shuffle ?? 0}`));
  requestAnimationFrame(() => paintPattern(canvas, Number(canvas.dataset.seed), channelsOf(box)));
  return canvas;
}
/** Pixel faces are painted in the theme's colours, so a change of theme paints them again. */
export function repaintPatterns(root = document) {
  for (const canvas of root.querySelectorAll("canvas.fc-pattern")) {
    const box = canvas.closest(".fc");
    if (box) paintPattern(canvas, Number(canvas.dataset.seed), channelsOf(box));
  }
}

/* ---------- the face itself ---------- */
/**
 * One face. `status` draws a ring that follows the shape: "on" (green), "wait" (amber: it needs
 * you), "off" (grey), "pairing" (a smooth turning ring). `working` animates Pulse and Dots.
 */
export function face(spec, size = 28, { status = null, working = false, ground = "surface", flat = false } = {}) {
  const wrap = document.createElement("span");
  wrap.className = `face face-${spec.kind} face-m-${spec.motion ?? "none"}${working ? " working" : ""}${status ? " ringed st-" + status : ""}`;
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.setProperty("--s", `${size}px`);
  wrap.style.setProperty("--m", maskOf(spec.shape));
  wrap.style.setProperty("--c", spec.colour);
  if (HEX.test(spec.colour)) wrap.style.setProperty("--ink", inkOn(spec.colour));
  wrap.dataset.ground = ground;
  if (status) wrap.append(Object.assign(document.createElement("i"), { className: "ring" }), Object.assign(document.createElement("i"), { className: "gap" }));
  const box = document.createElement("i");
  box.className = "fc";
  wrap.append(box);
  box.append(content(spec, box));
  if (spec.motion === "dots") wrap.append(Object.assign(document.createElement("b"), { className: "orb" }));
  if (!flat && spec.depth === "3d" && document.body.classList.contains("faces-3d")) giveDepth(wrap);
  return wrap;
}

/* ---------- the 3D stand-in: the shape as a thick tile that turns slowly ----------
   Hand-written CSS 3D (public/faces.css): six copies of the shape behind the face, each a little
   deeper and darker, in one turning block. No library, no model file; reduced motion keeps it still. */
function giveDepth(wrap) {
  wrap.classList.add("is3d");
  const block = document.createElement("span");
  block.className = "depth";
  for (let layer = 1; layer <= 6; layer++) {
    const slab = document.createElement("i");
    slab.className = "slab";
    slab.style.setProperty("--z", String(layer));
    block.append(slab);
  }
  block.append(...[...wrap.querySelectorAll(":scope > .fc")]);
  wrap.append(block);
}
