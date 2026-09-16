/**
 * Flows drawn as boxes and arrows, under Procedures. It only shows what is saved: every step is a
 * box in the order it happens, an arrow says what follows what, and a box that stops to ask or that
 * did not work is marked. Nothing here changes a flow; it is for seeing what one does at a glance.
 */
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";
const box = { width: 210, height: 58, gapY: 34, left: 16, top: 16 };
const colourFor = {
  done: "var(--ok, #2e7d32)", approved: "var(--ok, #2e7d32)", failed: "var(--danger, #c62828)",
  waiting: "var(--warn, #ef6c00)", running: "var(--accent, #1565c0)",
};

function node(tag, attributes = {}, text) {
  const made = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  if (text !== undefined) made.textContent = String(text);
  return made;
}
const clip = (text, max) => (String(text).length > max ? String(text).slice(0, max - 1) + "…" : String(text));

/** One box, with its name, what it does, and a colour for where it has got to. */
function drawNode(entry, at) {
  const y = box.top + at * (box.height + box.gapY);
  const group = node("g");
  group.append(node("rect", { x: box.left, y, width: box.width, height: box.height, rx: 10,
    fill: "var(--surface, #fff)", stroke: colourFor[entry.status] ?? "var(--border, #bbb)", "stroke-width": 2 }));
  group.append(node("text", { x: box.left + 12, y: y + 22, "font-size": 13, fill: "var(--text, #111)" }, clip(entry.name, 26)));
  group.append(node("text", { x: box.left + 12, y: y + 40, "font-size": 11, fill: "var(--muted, #666)" },
    clip(`${entry.kind} — ${entry.detail || entry.status}`, 32)));
  const title = node("title");
  title.textContent = `${entry.name}: ${entry.detail}\nWhere it has got to: ${entry.status}`;
  group.append(title);
  return group;
}
/** An arrow between two boxes, labelled when the flow can go two ways. */
function drawEdge(edge, positions) {
  const from = positions.get(edge.from), to = positions.get(edge.to);
  if (from === undefined || to === undefined) return null;
  const startY = box.top + from * (box.height + box.gapY) + box.height;
  const endY = box.top + to * (box.height + box.gapY);
  const side = edge.when === "skipped" ? box.left + box.width : box.left + box.width / 2;
  const group = node("g");
  const path = edge.when === "skipped"
    ? `M ${side} ${startY - box.height / 2} H ${side + 36} V ${endY + box.height / 2} H ${side}`
    : `M ${side} ${startY} V ${endY}`;
  group.append(node("path", { d: path, fill: "none", stroke: "var(--border, #999)", "stroke-width": 1.5,
    "marker-end": "url(#flow-arrow)" }));
  if (edge.when !== "next")
    group.append(node("text", { x: side + (edge.when === "skipped" ? 40 : 6), y: (startY + endY) / 2,
      "font-size": 10, fill: "var(--muted, #666)" }, edge.when === "matched" ? "as expected" : "otherwise"));
  return group;
}
function drawGraph(graph) {
  const positions = new Map(graph.nodes.map((entry) => [entry.id, entry.index]));
  const height = box.top * 2 + graph.nodes.length * (box.height + box.gapY);
  const svg = node("svg", { viewBox: `0 0 ${box.width + 140} ${height}`, width: "100%",
    height, role: "img", "aria-label": "The steps of this flow, in order" });
  const defs = node("defs");
  const marker = node("marker", { id: "flow-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.append(node("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--border, #999)" }));
  defs.append(marker);
  svg.append(defs);
  for (const edge of graph.edges) { const drawn = drawEdge(edge, positions); if (drawn) svg.append(drawn); }
  for (const [at, entry] of graph.nodes.entries()) svg.append(drawNode(entry, at));
  return svg;
}

function card(flow) {
  const node = document.createElement("div");
  node.className = "card";
  const heading = document.createElement("strong");
  heading.textContent = flow.name;
  const where = document.createElement("p");
  where.className = "meta";
  where.textContent = `${flow.description || "No description."} — ${whereItGot(flow)}`;
  node.append(heading, where, drawGraph(flow.graph));
  return node;
}
const whereItGot = (flow) => ({
  idle: "Not started yet.", running: "Working now.", paused: "Stopped part of the way through.",
  waiting_approval: "Waiting for you to say yes.", waiting_time: "Waiting for a time to come.",
  completed: "Finished.", failed: "Stopped because a step did not work.", interrupted: "Interrupted.",
}[flow.status] ?? flow.status);

export async function drawFlows() {
  const list = $("flows-list");
  if (!list) return;
  try {
    const { flows } = await api("flows");
    list.replaceChildren();
    if (!flows.length) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No flows saved yet. A flow is a list of steps the app works through on its own.";
      list.append(empty);
      return;
    }
    for (const flow of flows) list.append(card(flow));
  } catch (error) {
    list.textContent = error.message;
  }
}

$("flows-refresh")?.addEventListener("click", () => { void drawFlows(); });
document.querySelector('[data-view="procedures"]')?.addEventListener("click", () => { void drawFlows(); });
