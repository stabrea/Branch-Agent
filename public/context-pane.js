/* The context pane: what is true about the conversation you are looking at.
   Model in use, tasks running now, the receipts this conversation produced, and
   the memory it can draw on. No marketing copy. */
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/* Plain language for the outcomes src/receipts.ts reports. */
const OUTCOMES = {
  success: "checked and confirmed",
  unsigned: "no proof was kept",
  forged: "the proof did not match",
  modified: "changed after it was done",
  stalled: "stopped part-way",
  failed: "did not work",
  blocked: "not allowed",
};

function rows(id, items, empty) {
  const target = $(id);
  target.replaceChildren(...items);
  if (!items.length) target.append(el("p", empty, "context-empty"));
}
function row(title, meta) {
  const node = el("div", undefined, "context-row");
  node.append(el("strong", title));
  if (meta) node.append(el("span", meta, "meta"));
  return node;
}
const session = () => $("conversation").dataset.sessionId || null;

/** Tasks the assistant is working on right now, with the step it has reached. */
async function drawTasks() {
  const running = await api("activity").catch(() => []);
  const here = session();
  rows(
    "context-tasks",
    running.map((item) => {
      const node = row(item.prompt?.slice(0, 80) || "Task", item.current || "Working");
      if (item.sessionId === here) node.append(el("span", "this conversation", "meta"));
      const bar = el("div", undefined, "progress indeterminate");
      bar.append(el("div", undefined, "progress-bar"));
      node.append(bar);
      return node;
    }),
    "Nothing running.",
  );
}

/** What the last tasks in this conversation actually did, and whether it was proven. */
async function drawReceipts(state) {
  const here = session();
  const mine = (state.runs ?? []).filter((run) => !here || run.sessionId === here).slice(0, 3);
  const items = [];
  for (const run of mine) {
    const view = await api(`runs/${run.id}/receipts`).catch(() => null);
    if (!view) continue;
    for (const item of view.items.slice(-3))
      items.push(row(item.name || item.kind, OUTCOMES[item.outcome] ?? item.outcome));
    if (view.cost?.amount !== null && view.cost?.amount !== undefined)
      items.push(row(view.cost.display, `${run.model || "this model"} · one task`));
  }
  rows("context-receipts", items.slice(0, 6), here ? "No tool work in this conversation yet." : "Open a conversation to see its receipts.");
}

/** The saved facts the assistant can draw on while it answers. */
function drawFacts(state) {
  const facts = (state.memory ?? []).slice(-4).reverse();
  rows(
    "context-facts",
    facts.map((fact) => row(fact.data?.fact ?? fact.data?.text ?? "Saved fact", fact.data?.source || "saved")),
    "Nothing saved to memory yet.",
  );
}

let busy = false;
async function draw() {
  if (busy || $("workspace").hidden || document.body.classList.contains("no-aside")) return;
  busy = true;
  try {
    const state = await api("state");
    await drawTasks();
    await drawReceipts(state);
    drawFacts(state);
  } catch {
    /* the pane keeps whatever it last showed until the next pass */
  } finally {
    busy = false;
  }
}

setInterval(draw, 5000);
/* Opening another conversation changes what belongs here, so redraw at once. */
new MutationObserver(() => void draw()).observe($("conversation"), {
  attributes: true,
  attributeFilter: ["data-session-id"],
});
const workspace = $("workspace");
if (!workspace.hidden) void draw();
new MutationObserver(() => {
  if (!workspace.hidden) void draw();
}).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
$("aside-toggle").addEventListener("click", () => setTimeout(draw, 0));
