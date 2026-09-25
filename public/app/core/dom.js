/* The smallest DOM toolkit the window needs: lookups, escaping, the CSP-safe style pass, and one redraw scheduler. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/* The engine's policy refuses style="…" attributes, so markup carries data-css="…" and this applies it through the CSSOM,
   which the policy allows. Run it on anything just drawn with innerHTML. */
export function applyCss(root = document) {
  for (const node of root.querySelectorAll("[data-css]")) {
    node.style.cssText = node.dataset.css;
    node.removeAttribute("data-css");
  }
}

/* Draws html into a region and applies its styles. Returns the region. */
export function paint(region, html) {
  if (!region) return region;
  region.innerHTML = html;
  applyCss(region);
  return region;
}

/* Regions register a draw function; render() redraws all of them on the next frame, once, however often it is asked. */
const painters = [];
let queued = false;
export function onRender(draw) { painters.push(draw); }
export function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const draw of painters) {
      try { draw(); } catch (error) { console.error(error); }
    }
  });
}
/* A redraw that must happen now (after a click the person can see). */
export function renderNow() {
  queued = false;
  for (const draw of painters) {
    try { draw(); } catch (error) { console.error(error); }
  }
}
