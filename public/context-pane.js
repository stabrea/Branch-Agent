/* The context pane: what is true about the conversation you are looking at.
   Model in use, tasks running now, the receipts this conversation produced, and
   the memory it can draw on. No marketing copy. */
import { api } from "/app.js";
import { setActivityCount } from "/shell.js";

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
function drawTasks(running) {
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

/* What this conversation is working on, and what was kept when it grew long. */
async function drawWorking() {
  const here = session();
  if (!here) {
    rows("context-working", [], "Open a conversation to see what it is working on.");
    return;
  }
  const view = await api(`sessions/${here}/summary`).catch(() => null);
  const items = [];
  if (view?.working?.goal) items.push(row(view.working.goal, [view.working.file, view.working.tool].filter(Boolean).join(" · ")));
  for (const question of view?.summary?.openQuestions?.slice(0, 2) ?? []) items.push(row(question, "still open"));
  for (const pin of view?.pins?.slice(0, 2) ?? []) items.push(row(pin.content.slice(0, 80), "kept whatever happens"));
  rows("context-working", items, "Nothing recorded for this conversation yet.");
}

/**
 * A small page an outside server sent during this conversation. Nothing is shown until you ask
 * for it: the card is a name and a button, and pressing it puts the page in a frame that can run
 * nothing, reach nothing and remember nothing. The address it opens at works once and then stops.
 */
async function drawApps() {
  const here = session();
  const target = $("context-apps");
  if (!target) return;
  const { apps } = here ? await api(`mcp/apps?session=${encodeURIComponent(here)}`).catch(() => ({ apps: [] })) : { apps: [] };
  rows("context-apps", apps.map((app) => appCard(app)), "Nothing to open here.");
}
function appCard(app) {
  const node = row(`${app.server}: ${app.uri}`, "a page this server sent");
  const open = el("button", "Open in Branch");
  open.type = "button";
  open.addEventListener("click", async () => {
    open.disabled = true;
    try {
      const { url } = await api("mcp/app", { server: app.server, uri: app.uri, html: app.html });
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = `${app.server}: ${app.uri}`;
      frame.setAttribute("sandbox", "");
      frame.style.cssText = "width:100%;height:20rem;border:1px solid var(--line, #444);border-radius:.5rem";
      node.append(frame);
      open.remove();
    } catch (error) {
      node.append(el("span", error.message, "meta"));
      open.disabled = false;
    }
  });
  node.append(open);
  return node;
}

let busy = false;
async function draw() {
  if (busy || $("workspace").hidden) return;
  busy = true;
  try {
    /* The count beside Activity is kept up to date even when the pane is folded away. */
    const running = await api("activity").catch(() => []);
    setActivityCount(running.length);
    if (document.body.classList.contains("no-aside")) return;
    const state = await api("state");
    await drawWorking();
    drawTasks(running);
    await drawReceipts(state);
    drawFacts(state);
    await drawApps();
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
