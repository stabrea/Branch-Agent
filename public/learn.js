/**
 * mac7/learn: the map and the guided walk, in the Documents place.
 *
 * Two things on one card. The map is a picture of the groups a folder or a collection falls into,
 * drawn with the same hand-rolled SVG as the rest of the window -- no graph library, and never
 * four thousand things at once, which is a hairball nobody reads. The tour is one stop at a time:
 * a heading, a short paragraph, and underneath it, always, the line or the passage it came from.
 *
 * The picture is read-only on purpose, like the one in docs-3.js: every action is an ordinary
 * button beside it, so nothing on this card needs a mouse to be usable and everything can be named.
 * Under about 520 px the picture gives way to a plain list, so the page never scrolls sideways.
 */
import { t } from "./i18n.js";
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const ask = () => ({
  subject: $("learn-subject").value,
  of: $("learn-of").value.trim(),
  useModel: $("learn-use-model").checked,
});

/** What it would cost, before a button that spends anything is pressed. */
async function showCost() {
  const out = $("learn-cost-result");
  out.textContent = t("learn.status.workingOut");
  try {
    const answer = await api("learn/cost", ask());
    out.replaceChildren(el("p", answer.map.summary), el("p", answer.tour.summary));
  } catch (error) { out.textContent = error.message; }
}

async function buildMap() {
  const out = $("learn-map-result");
  out.textContent = t("learn.status.building");
  try {
    const answer = await api("learn/map", { subject: $("learn-subject").value, of: $("learn-of").value.trim() });
    out.replaceChildren();
    if (!answer.groups.length) {
      out.append(el("p", "There is nothing in it to map yet."));
      for (const limit of answer.limits ?? []) out.append(el("p", limit, "subtle"));
      return;
    }
    out.append(drawGroups(answer));
    for (const group of answer.groups)
      out.append(el("p", `${group.name} — ${group.things.length} part(s) — ${sourceOf(group.citation)}`, "meta"));
    out.append(el("p", answer.how, "meta"));
    for (const limit of answer.limits ?? []) out.append(el("p", limit, "subtle"));
  } catch (error) { out.textContent = error.message; }
}

/** One sentence saying where a claim came from, or plainly that it came from nowhere. */
export function sourceOf(citation) {
  if (!citation) return "no source recorded";
  if (citation.kind === "passage") {
    const where = [citation.document || "a document", citation.heading || ""].filter(Boolean).join(" — ");
    return citation.page === null || citation.page === undefined ? where : `${where}, page ${citation.page}`;
  }
  if (citation.kind === "code") return `${citation.path}, line ${citation.line}`;
  return citation.why || "nothing you can open";
}

/**
 * The groups round a circle: a name and a count each, never the individual things. A viewBox and no
 * fixed width, so it fits a 400 px window without a sideways bar.
 */
export function drawGroups(answer) {
  const groups = answer.groups.slice(0, 12);
  const width = 420, height = 260, middleX = width / 2, middleY = height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    `${answer.of}: ${groups.length} group(s) — ${groups.map((group) => `${group.name}, ${group.things.length} parts`).join("; ")}`);
  svg.style.maxWidth = "100%";
  for (const [at, group] of groups.entries()) {
    const angle = (at / Math.max(1, groups.length)) * Math.PI * 2;
    const x = middleX + Math.cos(angle) * 150, y = middleY + Math.sin(angle) * 95;
    svg.append(line(middleX, middleY, x, y), label(x, y, `${short(group.name)} · ${group.things.length}`));
  }
  svg.append(label(middleX, middleY, answer.of || "this", true));
  return svg;
}
const short = (name) => String(name).length > 22 ? `${String(name).slice(0, 21)}…` : String(name);
function line(x1, y1, x2, y2) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "line");
  for (const [name, value] of [["x1", x1], ["y1", y1], ["x2", x2], ["y2", y2]]) node.setAttribute(name, String(value));
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-opacity", "0.35");
  return node;
}
function label(x, y, text, strong = false) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("text-anchor", "middle");
  node.setAttribute("font-size", strong ? "13" : "11");
  node.setAttribute("fill", "currentColor");
  if (strong) node.setAttribute("font-weight", "600");
  node.textContent = String(text).slice(0, 30);
  return node;
}

/* ---------- the tour, one stop at a time ---------- */

let tour = null, at = 0;

async function startTour() {
  const out = $("learn-tour-result");
  out.textContent = t("learn.status.tourStops");
  try {
    tour = await api("learn/tour", ask());
    at = 0;
    showStop();
  } catch (error) { out.textContent = error.message; tour = null; $("learn-tour-controls").hidden = true; }
}
/** One stop: a heading, the words, and underneath them always the place they came from. */
export function showStop() {
  const out = $("learn-tour-result");
  out.replaceChildren();
  if (!tour || !tour.steps.length) {
    out.append(el("p", "There is nothing to walk through yet."));
    $("learn-tour-controls").hidden = true;
    return;
  }
  const step = tour.steps[at];
  out.append(el("h3", step.title));
  out.append(el("p", `Stop ${step.order} of ${tour.steps.length}`, "meta"));
  out.append(el("p", step.words));
  const where = el("p", `Where this comes from: ${sourceOf(step.citation)}`, "meta");
  if (!step.citation || step.citation.kind === "none") where.className = "subtle";
  out.append(where);
  if (step.writtenByModel)
    out.append(el("p", "This paragraph was written by the assistant from the source named above, not copied from it.", "subtle"));
  for (const limit of tour.limits ?? []) out.append(el("p", limit, "subtle"));
  $("learn-tour-controls").hidden = false;
  $("learn-tour-back").disabled = at === 0;
  $("learn-tour-next").disabled = at >= tour.steps.length - 1;
}

export function setUpLearn() {
  if (!$("learn-card")) return;
  $("learn-cost-go").addEventListener("click", showCost);
  $("learn-map-go").addEventListener("click", buildMap);
  $("learn-tour-go").addEventListener("click", startTour);
  $("learn-tour-back").addEventListener("click", () => { if (at > 0) { at -= 1; showStop(); } });
  $("learn-tour-next").addEventListener("click", () => { if (tour && at < tour.steps.length - 1) { at += 1; showStop(); } });
}
setUpLearn();
