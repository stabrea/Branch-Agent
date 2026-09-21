/**
 * Three small additions to Documents. Write a document — a Word file, a spreadsheet, a slide deck
 * or a note — from a heading and a few lines. Ask for a summary of a whole knowledge base, with a
 * numbered source under every point. And look at the map of names a knowledge base mentions, drawn
 * as a simple picture, with the file each link came from named underneath it.
 *
 * Everything here only ever asks the same routes the assistant uses. Nothing is removed from
 * anywhere by any button on this panel: the limits button makes suggestions and stops there.
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

/** The lines typed into the box, turned into the blocks a document is written from. */
export function blocksFromLines(text) {
  const blocks = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); continue; }
    const item = /^[-*]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (item && last?.kind === "list") { last.items.push(item[1]); continue; }
    if (item) { blocks.push({ kind: "list", ordered: false, items: [item[1]] }); continue; }
    blocks.push({ kind: "paragraph", text: line });
  }
  return blocks;
}

async function writeDocument() {
  const path = $("docs3-write-path").value.trim(), title = $("docs3-write-title").value.trim();
  const out = $("docs3-write-result");
  if (!path) { out.textContent = t("docs.status.nameTheFile"); return; }
  const blocks = blocksFromLines($("docs3-write-body").value);
  out.textContent = t("docs.status.writing");
  try {
    const answer = await run("documents.write", { path, title, blocks });
    out.replaceChildren(el("p", `Saved ${answer.path} (${Math.round((answer.bytes ?? 0) / 1024)} KB).`));
    for (const limit of answer.limits ?? []) out.append(el("p", limit, "subtle"));
  } catch (error) { out.textContent = error.message; }
}

async function summarise() {
  const collection = $("docs3-summary-collection").value.trim();
  const out = $("docs3-summary-result");
  if (!collection) { out.textContent = t("docs.status.whichKnowledgeBase"); return; }
  out.textContent = t("docs.status.reading");
  try {
    const answer = await api("knowledge/summarise", { collection, focus: $("docs3-summary-focus").value.trim() });
    out.replaceChildren(el("p", answer.summary || "There is nothing in it yet."));
    if (answer.note) out.append(el("p", answer.note, "subtle"));
    out.append(el("p", `${answer.passages} passage(s) read${answer.cached ? ", from what was written last time" : ""}.`, "meta"));
  } catch (error) { out.textContent = error.message; }
}

async function showMap() {
  const collection = $("docs3-map-collection").value.trim(), entity = $("docs3-map-entity").value.trim();
  const out = $("docs3-map-result");
  if (!collection || !entity) { out.textContent = t("docs.status.whichBaseAndName"); return; }
  out.textContent = t("docs.status.looking");
  try {
    const answer = await api("knowledge/graph", { collection, entity, depth: 1 });
    out.replaceChildren();
    if (!answer.found) { out.append(el("p", answer.limits?.[0] ?? "Nothing by that name.")); return; }
    out.append(drawMap(answer));
    for (const link of answer.links.slice(0, 12))
      out.append(el("p", `${link.from} — ${link.relation} — ${link.to} (${link.citation.document || "a passage"})`, "meta"));
    for (const limit of answer.limits ?? []) out.append(el("p", limit, "subtle"));
  } catch (error) { out.textContent = error.message; }
}
/**
 * The neighbourhood drawn as a simple picture: the name asked about in the middle, everything
 * mentioned with it around the edge. It is read-only; clicking it does nothing, on purpose.
 */
export function drawMap(answer) {
  const around = answer.entities.filter((entity) => entity.name !== answer.entity).slice(0, 10);
  const width = 420, height = 240, middleX = width / 2, middleY = height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${answer.entity} and the ${around.length} things mentioned with it`);
  svg.style.maxWidth = "100%";
  for (const [at, entity] of around.entries()) {
    const angle = (at / Math.max(1, around.length)) * Math.PI * 2;
    const x = middleX + Math.cos(angle) * 150, y = middleY + Math.sin(angle) * 90;
    svg.append(line(middleX, middleY, x, y), label(x, y, entity.name));
  }
  svg.append(label(middleX, middleY, answer.entity, true));
  return svg;
}
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
  node.textContent = String(text).slice(0, 28);
  return node;
}

/** The limits check: it only ever writes suggestions into the Memory screen. */
async function checkLimits() {
  const out = $("docs3-limits-result");
  out.textContent = t("docs.status.looking");
  try {
    const answer = await api("knowledge/retention/check", {});
    if (!answer.proposals.length) { out.textContent = t("docs.status.nothingOverLimits"); return; }
    out.replaceChildren(el("p", `${answer.proposals.length} knowledge base(s) are over. Nothing was removed; each is waiting in Memory for you to decide.`));
    for (const proposal of answer.proposals) out.append(el("p", proposal.note, "meta"));
  } catch (error) { out.textContent = error.message; }
}

const run = async (name, input) => {
  const result = await api("tools/try", { name, input });
  return result.result ?? result;
};

export function setUpDocs3() {
  if (!$("docs3-card")) return;
  $("docs3-write-go").addEventListener("click", writeDocument);
  $("docs3-summary-go").addEventListener("click", summarise);
  $("docs3-map-go").addEventListener("click", showMap);
  $("docs3-limits-go").addEventListener("click", checkLimits);
}
setUpDocs3();
