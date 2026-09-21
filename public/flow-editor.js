/**
 * Changing a flow, not only looking at one. The picture from public/flows.js is drawn from the
 * steps being edited, so a change is seen before it is saved; the side form under each step shows
 * only the boxes that kind of step actually needs, which is what the saved shape itself requires.
 *
 * Under the picture, a timeline of the run: each step, where it has got to and how long it took.
 * Wave 9: while a flow drawn as a graph is working, its boxes report themselves down the same run
 * socket every task already uses, so the timeline is redrawn when something actually happens
 * rather than once a second whether anything happened or not. A flow still saved as a plain list
 * has no task of its own to watch, so that one is read back once when it finishes.
 *
 * Beside it, a rhythm picker: a repeat and a time, written out in plain words before it is used.
 */
import { api } from "/app.js";
import { drawGraph } from "/flows.js";
import { formatDate, t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const say = (message) => { const box = $("editor-status"); if (box) box.textContent = message; };

/**
 * Which boxes each kind of step needs. The saved shape refuses a prompt step with no prompt and a
 * branch step with no words to look for, so a form that offered every box for every kind would
 * simply be refused; these are the same rules, written where the owner can see them.
 */
export const STEP_FIELDS = {
  prompt: [["prompt", "What to ask", "text", true]],
  recipe: [["recipeId", "Which saved procedure", "text", true]],
  tool: [["tool", "Which tool", "text", true], ["args", "What to give it (JSON)", "json", false]],
  flow: [["flowId", "Which other flow to work through first", "text", true]],
  approval: [["question", "What to ask you before going on", "text", false]],
  wait: [["waitMinutes", "How many minutes to wait", "number", false]],
  branch: [["contains", "Words the last answer must contain", "text", true],
    ["skipAhead", "How many steps to jump over otherwise", "number", false]],
};
export const STEP_KINDS = Object.keys(STEP_FIELDS);

let steps = [];
let chosen = "";

/** The picture, drawn from the steps as they stand now rather than from anything saved. */
function redrawPicture() {
  const host = $("editor-picture");
  if (!host) return;
  const nodes = steps.map((step, index) => ({ id: `n${index + 1}`, index, name: step.name,
    kind: step.kind, detail: detailOf(step), status: "waiting", attempts: 0, output: "", startedAt: null }));
  const edges = [];
  for (const [index, step] of steps.entries()) {
    const next = index + 1;
    if (step.kind === "branch") {
      if (next < steps.length) edges.push({ from: `n${index + 1}`, to: `n${next + 1}`, when: "matched" });
      const skipped = next + (Number(step.skipAhead) || 1);
      if (skipped < steps.length) edges.push({ from: `n${index + 1}`, to: `n${skipped + 1}`, when: "skipped" });
      continue;
    }
    if (next < steps.length) edges.push({ from: `n${index + 1}`, to: `n${next + 1}`, when: "next" });
  }
  host.replaceChildren(nodes.length ? drawGraph({ nodes, edges }) : el("p", t("editor.noSteps"), "meta"));
}
const detailOf = (step) => String(step.prompt ?? step.tool ?? step.question ?? step.contains ?? step.kind).slice(0, 60);

/** One box on the side form, keeping what is typed on the step itself as it is typed. */
function field(step, [name, label, type, required], at) {
  const wrap = el("div");
  const id = `editor-${at}-${name}`;
  const tag = el("label", `${label}${required ? " *" : ""}`);
  tag.htmlFor = id;
  const box = el("input");
  box.id = id;
  box.type = type === "number" ? "number" : "text";
  box.value = type === "json" && step[name] ? JSON.stringify(step[name]) : String(step[name] ?? "");
  box.addEventListener("input", () => {
    if (!box.value) { delete step[name]; }
    else if (type === "number") step[name] = Number(box.value);
    else if (type === "json") { try { step[name] = JSON.parse(box.value); } catch { /* still being typed */ } }
    else step[name] = box.value;
    redrawPicture();
  });
  wrap.append(tag, box);
  return wrap;
}

/** One step as a row: what it is called, what kind it is, its own boxes, and where it can move. */
function stepRow(step, at) {
  const row = el("article", undefined, "card-row editor-step");
  const name = el("input");
  name.type = "text";
  name.value = step.name;
  name.setAttribute("aria-label", `Name of step ${at + 1}`);
  name.addEventListener("input", () => { step.name = name.value; redrawPicture(); });
  row.append(el("strong", `${at + 1}. ${step.kind}`), name);
  const form = el("div", undefined, "row-fields");
  for (const shape of STEP_FIELDS[step.kind] ?? []) form.append(field(step, shape, at));
  row.append(form);

  const buttons = el("div", undefined, "todo-actions");
  for (const [label, move] of [[t("editor.up"), -1], [t("editor.down"), 1]]) {
    const button = el("button", label, "text-button");
    button.type = "button";
    button.addEventListener("click", () => {
      const to = at + move;
      if (to < 0 || to >= steps.length) return;
      [steps[at], steps[to]] = [steps[to], steps[at]];
      drawSteps();
    });
    buttons.append(button);
  }
  const drop = el("button", t("editor.remove"), "text-button");
  drop.type = "button";
  drop.addEventListener("click", () => { steps.splice(at, 1); drawSteps(); });
  buttons.append(drop);
  row.append(buttons);
  return row;
}

function drawSteps() {
  const list = $("editor-steps");
  if (!list) return;
  list.replaceChildren(...steps.map((step, at) => stepRow(step, at)));
  redrawPicture();
}

/** The flows on file, so one can be opened; "New flow" starts from nothing. */
async function fillFlows() {
  const picker = $("editor-flow");
  if (!picker) return;
  try {
    const { flows } = await api("flows");
    picker.replaceChildren(new Option(t("editor.newFlow"), ""));
    for (const flow of flows) picker.append(new Option(flow.name, flow.id));
    picker.value = chosen;
  } catch (error) { say(error.message); }
}

/** Opens one flow into the editor. Only the steps come across; the picture is drawn from them. */
async function openFlow(id) {
  chosen = id;
  if (!id) { steps = []; $("editor-name").value = ""; $("editor-description").value = ""; drawSteps(); return; }
  try {
    const flow = await api(`flows/${id}`);
    $("editor-name").value = flow.name;
    $("editor-description").value = flow.description ?? "";
    steps = (flow.steps ?? []).map((step) => ({ ...step }));
    drawSteps();
    /* A flow drawn as a graph is not a list of steps, so this form cannot change it. The picture
       and the timeline still show it, and Run and Carry on still work on it. */
    if (flow.kind === "graph") {
      $("editor-picture")?.replaceChildren(drawGraph(flow.graph));
      say(t("editor.graphOnly"));
    }
    await drawTimeline();
  } catch (error) { say(error.message); }
}

/**
 * Saves. Only the three things the saved shape accepts are sent — a name, a line about it, and the
 * steps. Sending back the whole flow as it was read would carry the picture and the status with it,
 * which that shape refuses outright.
 */
async function save() {
  const body = {
    name: $("editor-name").value.trim(),
    description: $("editor-description").value.trim(),
    nodes: steps.map((step) => ({ ...step })),
  };
  if (!body.name) { say(t("editor.needName")); return; }
  if (!body.nodes.length) { say(t("editor.needStep")); return; }
  try {
    const saved = chosen ? await api(`flows/${chosen}`, body, "PUT") : await api("flows", body);
    chosen = saved.id;
    await fillFlows();
    $("editor-flow").value = chosen;
    say(t("editor.saved"));
  } catch (error) { say(error.message); }
}

/** One row of the timeline: which box, where it has got to, and when it last moved. */
function timelineRow(order, name, status, when, attempts) {
  const row = el("article", undefined, "card-row");
  row.append(el("strong", `${order}. ${name}`));
  const started = when ? formatDate(when) : t("editor.notStarted");
  row.append(el("span", `${status} · ${started}${attempts ? ` · ${attempts} tries` : ""}`, "meta"));
  return row;
}

/**
 * Each step, where it has got to and how long it took. With a run id it reads that one run of a
 * graph flow, box by box; without one it reads the flow itself, which is what a flow saved as a
 * plain list has.
 */
export async function drawTimeline(runId) {
  const list = $("editor-timeline");
  if (!list || (!chosen && !runId)) return;
  try {
    if (runId) {
      const run = await api(`flows/runs/${runId}`);
      list.replaceChildren(...run.nodes.map((node, at) =>
        timelineRow(at + 1, node.name, node.status, node.updatedAt, 0)));
      if (run.error) list.append(el("p", run.error, "meta"));
      return run.status;
    }
    const flow = await api(`flows/${chosen}`);
    list.replaceChildren(...flow.graph.nodes.map((node) =>
      timelineRow(node.index + 1, node.name, node.status, node.startedAt, node.attempts)));
    return flow.status;
  } catch (error) { list.replaceChildren(el("p", error.message, "meta")); return null; }
}

const socketToken = () => sessionStorage.getItem("branch-token") || "";
/**
 * Watches one run of a graph flow down the run socket every task already uses. Each box says when
 * it starts, when it finishes and when it fails; the timeline is redrawn on each of those and once
 * more when the socket says the task is over.
 */
export function watchRun(runId, onEnd) {
  let socket = null;
  try {
    socket = new WebSocket(new URL(`/api/runs/${runId}/ws`, location.href).href.replace(/^http/, "ws"),
      ["bearer", socketToken()]);
  } catch { void drawTimeline(runId).then(() => onEnd?.()); return null; }
  socket.addEventListener("message", (event) => {
    let payload = {};
    try { payload = JSON.parse(event.data); } catch { return; }
    if (typeof payload.kind === "string" && payload.kind.startsWith("flow.node")) void drawTimeline(runId);
    if (payload.kind === "end") { void drawTimeline(runId).then(() => onEnd?.()); try { socket.close(); } catch { /* gone */ } }
  });
  socket.addEventListener("close", () => { void drawTimeline(runId); });
  socket.addEventListener("error", () => { void drawTimeline(runId).then(() => onEnd?.()); });
  return socket;
}

/** Starts or carries on the open flow, and follows it down the socket while it works. */
async function runFlow(how = "run") {
  if (!chosen) { say(t("editor.needFlow")); return; }
  say(t("editor.running"));
  try {
    const started = await api(`flows/${chosen}/${how}`, {});
    /* A flow drawn as a graph hands back its task id before any box has run, so it can be watched.
       One still saved as a plain list has finished by the time the answer comes back. */
    if (started?.runId) watchRun(started.runId, () => say(t("editor.finished")));
    else { say(t("editor.finished")); await drawTimeline(); }
  } catch (error) { say(error.message); await drawTimeline(); }
}

/* ---------- The rhythm picker (A2093) ---------- */
const RHYTHMS = [
  ["daily", "Every day"], ["weekday", "Every weekday"], ["weekly", "Every week"],
  ["hourly", "Every hour"], ["6h", "Every six hours"], ["30m", "Every half hour"],
];
/** The chosen rhythm written out the way a person would say it. */
export function rhythmInWords(rhythm, time) {
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "09:00";
  const spoken = { daily: `every day at ${at}`, weekday: `every weekday at ${at}`,
    weekly: `every week at ${at}`, hourly: "every hour, on the hour",
    "6h": "every six hours", "30m": "every half hour" }[rhythm];
  return spoken ?? `every day at ${at}`;
}
/** The same rhythm as the schedules understand it: a daily time, or a gap in milliseconds. */
export function rhythmAsSchedule(rhythm, time, weekday = new Date().getDay()) {
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "09:00";
  if (rhythm === "hourly") return { intervalMs: 3_600_000 };
  if (rhythm === "6h") return { intervalMs: 21_600_000 };
  if (rhythm === "30m") return { intervalMs: 1_800_000 };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (rhythm === "weekly") return { dailyAt: at, timezone, weekdays: [Number(weekday)] };
  if (rhythm === "weekday") return { dailyAt: at, timezone, weekdays: [1, 2, 3, 4, 5] };
  return { dailyAt: at, timezone };
}
function previewRhythm() {
  const box = $("repeat-preview");
  if (!box) return;
  box.textContent = t("repeat.preview", { words: rhythmInWords($("repeat-every").value, $("repeat-at").value) });
}

function wire() {
  const rhythms = $("repeat-every");
  if (rhythms && !rhythms.options.length)
    for (const [id, label] of RHYTHMS) rhythms.append(new Option(label, id));
  const kinds = $("editor-kind");
  if (kinds && !kinds.options.length) for (const kind of STEP_KINDS) kinds.append(new Option(kind, kind));
  previewRhythm();
}
$("editor-flow")?.addEventListener("change", (event) => { void openFlow(event.target.value); });
$("editor-add")?.addEventListener("click", () => {
  const kind = $("editor-kind").value || "prompt";
  steps.push({ name: `Step ${steps.length + 1}`, kind, retries: 0, timeoutMs: 120000 });
  drawSteps();
});
$("editor-save")?.addEventListener("click", () => { void save(); });
$("editor-run")?.addEventListener("click", () => { void runFlow("run"); });
$("editor-resume")?.addEventListener("click", () => { void runFlow("resume"); });
$("repeat-every")?.addEventListener("change", previewRhythm);
$("repeat-at")?.addEventListener("input", previewRhythm);
$("repeat-use")?.addEventListener("click", () => {
  const wanted = rhythmAsSchedule($("repeat-every").value, $("repeat-at").value, Number($("schedule-weekday")?.value ?? 1));
  /* The schedules screen owns the boxes; this only fills them in with the chosen rhythm. */
  if (wanted.dailyAt && $("schedule-daily")) $("schedule-daily").value = wanted.dailyAt;
  if (wanted.weekdays?.length === 5) $("schedule-repeat").value = "weekdays";
  else if (wanted.weekdays) { $("schedule-repeat").value = "weekly"; $("schedule-weekday").value = String(wanted.weekdays[0]); }
  else if (wanted.dailyAt) $("schedule-repeat").value = "daily";
  else if (wanted.intervalMs) $("schedule-repeat").value = String(wanted.intervalMs);
  $("schedule-repeat")?.dispatchEvent(new Event("change"));
  $("repeat-preview").textContent = t("repeat.used", { words: rhythmInWords($("repeat-every").value, $("repeat-at").value) });
});
document.querySelector('[data-view="procedures"]')?.addEventListener("click", () => { void fillFlows(); });

wire();
drawSteps();
void fillFlows();
