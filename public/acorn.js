// KeepOak's analytic, dithered acorn artwork, adapted for Branch Agent.
import { t } from "/i18n.js";
const shapes = [
  { center: [0, -.26, 0], radius: [.66, .8, .66], material: 0 },
  { center: [0, -.94, 0], radius: [.24, .34, .24], material: 0 },
  { center: [0, .4, 0], radius: [.78, .44, .78], material: 1 },
  { center: [0, .82, 0], radius: [.09, .22, .09], material: 2 },
];
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const light = [-.5, .7, .85].map((value) => value / Math.hypot(-.5, .7, .85));

function intersection(shape, origin, direction) {
  const p = origin.map((value, i) => (value - shape.center[i]) / shape.radius[i]);
  const q = direction.map((value, i) => value / shape.radius[i]);
  const a = q.reduce((sum, value) => sum + value * value, 0);
  const b = 2 * p.reduce((sum, value, i) => sum + value * q[i], 0);
  const c = p.reduce((sum, value) => sum + value * value, -1);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const span = [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  return span[1] > 0 ? span : null;
}

function nearestSurface(origin, direction) {
  const spans = shapes.map((shape) => intersection(shape, origin, direction));
  let distance = Infinity, selected = -1;
  spans.forEach((span, index) => {
    if (!span) return;
    const hit = Math.max(0, span[0]);
    if (hit >= distance) return;
    const buried = spans.some((other, i) => i !== index && other && hit > other[0] && hit < other[1]);
    if (!buried) { distance = hit; selected = index; }
  });
  return selected < 0 ? null : {
    shape: shapes[selected], point: origin.map((value, i) => value + direction[i] * distance),
  };
}

function surfaceColor(surface, lighting, palette, x, y) {
  const { shape, point } = surface;
  const normal = point.map((value, i) => (value - shape.center[i]) / shape.radius[i] ** 2);
  const length = Math.hypot(...normal) || 1;
  const diffuse = Math.max(0, normal.reduce((sum, value, i) => sum + value * lighting[i], 0) / length);
  let shade = (.05 + .95 * diffuse) ** 1.3;
  if (shape.material === 1)
    shade *= .7 + .3 * (Math.sin(Math.atan2(point[2], point[0]) * 16) * Math.sin(point[1] * 46) > 0 ? 1 : .3);
  return shade > (bayer[(y & 3) * 4 + (x & 3)] + .5) / 16 ? palette[shape.material] : null;
}

function rotation(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return ([x, y, z]) => {
    const rotatedX = x * cy - z * sy, rotatedZ = x * sy + z * cy;
    return [rotatedX, y * cp + rotatedZ * sp, -y * sp + rotatedZ * cp];
  };
}

/* The acorn takes its three colours from the token layer, so it follows the
   theme and the highlight colour chosen in Appearance. */
let paletteKey = "", paletteCache = null;
/** A token as red, green and blue, with any transparency laid over `over`. */
function channels(token, over = [0, 0, 0]) {
  const probe = document.createElement("span");
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  document.body.append(probe);
  const parts = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
  probe.remove();
  const alpha = parts.length > 3 ? parts[3] : 1;
  return parts
    .slice(0, 3)
    .map((part, index) => Math.round(part * alpha + over[index] * (1 - alpha)));
}
function themePalette() {
  // phase2/delight: keyed by the colours themselves, since a theme's colours can land after its name.
  const style = getComputedStyle(document.documentElement);
  const key = ["--ground", "--text", "--copper", "--faint"].map((name) => style.getPropertyValue(name)).join("/");
  if (key !== paletteKey) {
    paletteKey = key;
    const ground = channels("--ground");
    paletteCache = [
      channels("--text", ground),
      channels("--copper", ground),
      channels("--faint", ground),
    ];
  }
  return paletteCache;
}

function render(canvas, yaw, pitch) {
  const context = canvas.getContext("2d");
  const width = canvas.width, height = canvas.height;
  const image = context.createImageData(width, height);
  const rotate = rotation(yaw, pitch), lighting = rotate(light);
  const palette = themePalette();
  const unit = Math.max(2.75 / height, 1.95 / width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + .5 - width / 2) * unit, v = (height / 2 - y - .5) * unit - .1;
    const origin = rotate([u * .34, v * .34, 3]);
    const ray = rotate([u * .3, v * .3, -1]);
    const length = Math.hypot(...ray), direction = ray.map((value) => value / length);
    const surface = nearestSurface(origin, direction);
    const color = surface && surfaceColor(surface, lighting, palette, x, y);
    if (color) image.data.set([...color, 255], (y * width + x) * 4);
  }
  context.putImageData(image, 0, 0);
}

const canvas = document.getElementById("keepoak-acorn");
const toggle = document.getElementById("acorn-motion");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let yaw = .6, pitch = .14, drag = null, visible = false;
let paused = reduced.matches, frame = 0, last = 0;
const draw = () => render(canvas, yaw, pitch);
const shouldAnimate = () => !paused && visible && !document.hidden;

function animate(now) {
  frame = 0;
  if (!shouldAnimate()) return;
  if (now - last >= 40) {
    if (!drag) yaw += Math.min(100, last ? now - last : 16) * .00024;
    last = now;
    draw();
  }
  frame = requestAnimationFrame(animate);
}

/** A word from the language file, or the English one while the file is still loading. */
const say = (key, english) => (t(key) === key ? english : t(key));
function updateMotion() {
  // phase2/delight: the corner's pause is a small icon button, so its words are its name and tooltip.
  const words = paused ? say("action.resume-rotation", "Resume rotation") : say("action.pause-rotation", "Pause rotation");
  toggle.setAttribute("aria-label", words);
  toggle.title = words;
  toggle.dataset.paused = String(paused);
  toggle.setAttribute("aria-pressed", String(paused));
  if (shouldAnimate() && !frame) { last = 0; frame = requestAnimationFrame(animate); }
  if (!shouldAnimate() && frame) { cancelAnimationFrame(frame); frame = 0; }
}

function resize() {
  const box = canvas.getBoundingClientRect();
  // phase2/delight (integration review): the corner's small acorn is drawn a pixel per screen pixel, as in
  // the approved sample (56 in a 58px tile); 40 stretched to 56 made uneven pixels. A big one stays chunky.
  const scale = box.width > 0 && box.width <= 80 ? 1 : 2.5;
  canvas.width = Math.max(40, Math.min(150, Math.round(box.width / scale)));
  canvas.height = Math.max(40, Math.min(150, Math.round(box.height / scale)));
  draw();
}

canvas.addEventListener("pointerdown", (event) => {
  drag = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  yaw += (event.clientX - drag.x) * .014;
  pitch = Math.max(-.7, Math.min(.7, pitch + (event.clientY - drag.y) * .008));
  drag = { x: event.clientX, y: event.clientY };
  draw();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((name) => {
  canvas.addEventListener(name, () => { drag = null; });
});
canvas.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  yaw += event.key === "ArrowLeft" ? -.15 : event.key === "ArrowRight" ? .15 : 0;
  pitch = Math.max(-.7, Math.min(.7, pitch + (event.key === "ArrowUp" ? -.1 : event.key === "ArrowDown" ? .1 : 0)));
  draw();
});
toggle.addEventListener("click", () => { paused = !paused; updateMotion(); });
reduced.addEventListener("change", () => { paused = reduced.matches; updateMotion(); });
document.addEventListener("visibilitychange", updateMotion);
document.addEventListener("branch-language", updateMotion);
window.addEventListener("blur", () => { drag = null; });
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; updateMotion(); }).observe(canvas);
new ResizeObserver(resize).observe(canvas);
new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-palette", "style"] });
resize();
updateMotion();

/* DG-192: Settings › Updates & about › The keeper is the same acorn, bigger and still: drag it, or use the arrow keys,
   to turn it. It is drawn a little chunky (a pixel is 2.5 screen pixels), as the corner's big one is. */
const keeper = document.getElementById("about-acorn");
if (keeper) {
  const turn = { yaw: .6, pitch: .14, drag: null };
  const drawKeeper = () => render(keeper, turn.yaw, turn.pitch);
  const fit = () => {
    const box = keeper.getBoundingClientRect();
    if (!box.width) return;
    keeper.width = Math.max(40, Math.min(150, Math.round(box.width / 2.5)));
    keeper.height = Math.max(40, Math.min(150, Math.round(box.height / 2.5)));
    drawKeeper();
  };
  keeper.addEventListener("pointerdown", (event) => { turn.drag = { x: event.clientX, y: event.clientY }; keeper.setPointerCapture(event.pointerId); });
  keeper.addEventListener("pointermove", (event) => {
    if (!turn.drag) return;
    turn.yaw += (event.clientX - turn.drag.x) * .014;
    turn.pitch = Math.max(-.7, Math.min(.7, turn.pitch + (event.clientY - turn.drag.y) * .008));
    turn.drag = { x: event.clientX, y: event.clientY };
    drawKeeper();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) => keeper.addEventListener(name, () => { turn.drag = null; }));
  keeper.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, -.1], ArrowDown: [0, .1] }[event.key];
    if (!step) return;
    event.preventDefault();
    turn.yaw += step[0];
    turn.pitch = Math.max(-.7, Math.min(.7, turn.pitch + step[1]));
    drawKeeper();
  });
  new ResizeObserver(fit).observe(keeper);
  new MutationObserver(drawKeeper).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-palette", "style"] });
}
