/* Seeing what a task did, step by step, afterwards (public list, bucket 13). Two cards, each placed
   by public/layout.js through its data-home:

   1. Inbox → History: "Watch a task again". The switch, then a task to pick, a player that steps
      through what it did, the picture of the path it took, the words its flow boxes used, and two
      ways to keep it — a page to save and open anywhere, or a workflow that repeats its actions.
   2. Settings → Advanced: "Is Branch keeping up". The switch for the event-loop watch, and its
      reading in one sentence.

   Every word is behind a key; every colour comes from the page's tokens. */
import { api } from "/app.js";
import { t, formatNumber, language } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  node.style.overflowWrap = "anywhere";
  return node;
}
/* A step's fixed words come with their own key (the server's English stays behind them). */
const frameLabel = (frame) => (frame.words ? say(frame.words.key, frame.label, frame.words.values) : frame.label);
function button(key, english, className, handler) {
  const node = make("button", className, key, english);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

const POSITIONS = [
  ["off", "field.switch-off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "field.switch-on", "On"],
];
function switchSelect(id, mode) {
  return segmented({ id, options: POSITIONS, value: mode });
}
function status() {
  const node = make("p", "subtle");
  node.setAttribute("role", "status");
  return node;
}

/* ------------------------------------------------------------ Watch a task again */

function recordingsCard(state) {
  const card = make("section", "card");
  card.id = "recordings-card";
  card.dataset.home = "settings:automations";
  /* Its section heading already says "Watch a task again": the title stays for a screen reader, not shown twice (DG-032). */
  card.append(make("h3", "settings-card-title sr-only", "recordings.title", "Watch a task again"),
    make("p", "subtle", "recordings.purpose", "Play back what a finished task did, one step at a time, see the path it took, and keep it as a page or a workflow."));
  const label = make("label", "", "recordings.switch", "Recordings of tasks");
  label.htmlFor = "recordings-mode";
  const select = switchSelect("recordings-mode", state.settings.mode);
  const pictures = document.createElement("input");
  pictures.type = "checkbox";
  pictures.id = "recordings-pictures";
  pictures.checked = state.settings.pictures;
  const pictureLabel = make("label", "", "recordings.pictures", "Put the pictures it looked at into saved pages");
  pictureLabel.htmlFor = pictures.id;
  const pictureRow = document.createElement("div");
  pictureRow.className = "check-row";
  pictureRow.append(pictures, pictureLabel);
  const saved = status();
  /* Two separate settings, each saved as it changes (DG-025). The card is drawn again from what was saved, and says
     "Saved." or why it was refused. */
  const save = async () => {
    let words;
    try {
      await api("recordings", { mode: select.value, pictures: pictures.checked });
      words = say("recordings.saved", "Saved.");
    } catch (error) { words = error.message; }
    await drawRecordings();
    ($("recordings-card")?.querySelector(":scope > [role=status]") ?? saved).textContent = words;
  };
  select.addEventListener("change", save);
  pictures.addEventListener("change", save);
  card.append(label, select, pictureRow, saved);
  if (state.settings.mode !== "off") card.append(...picker(state.tasks));
  return card;
}

function picker(tasks) {
  if (!tasks.length) return [make("p", "empty-state", "recordings.none", "No tasks yet. Once a task has finished, it can be played back here.")];
  const label = make("label", "", "recordings.pick", "Task");
  label.htmlFor = "recordings-task";
  const options = tasks.map((task) => [task.id, `${task.createdAt.slice(0, 16).replace("T", " ")} — ${task.prompt || task.id}`]);
  const select = dropdown({
    id: "recordings-task",
    options: options.length > 0 ? options : [["", "No tasks"]],
    value: options.length > 0 ? options[0][0] : ""
  });
  const stage = document.createElement("div");
  stage.id = "recordings-stage";
  const open = button("recordings.open", "Play it back", "quiet-button", () => void openRecording(select.value, stage));
  return [label, select, open, stage];
}

async function openRecording(runId, stage) {
  stage.replaceChildren(make("p", "subtle", "recordings.loading", "Reading the task's record…"));
  try {
    const [recording, path, monitor] = await Promise.all([
      api(`runs/${runId}/recording`), api(`runs/${runId}/recording/path`), api(`runs/${runId}/monitor`),
    ]);
    stage.replaceChildren(...player(recording), ...pathBlock(path.svg), ...boxWords(monitor), ...keepers(runId));
  } catch (error) {
    stage.replaceChildren(plain("p", error.message, "subtle"));
  }
}

function player(recording) {
  const frames = recording.frames;
  let index = 0, timer = null;
  const counts = plain("p", say("recordings.counts", `${recording.counts.rounds} rounds with the model, ${recording.counts.actions} actions, ${recording.counts.failed} failed, ${recording.seconds}s`, {
    rounds: formatNumber(recording.counts.rounds), actions: formatNumber(recording.counts.actions),
    failed: formatNumber(recording.counts.failed), seconds: formatNumber(recording.seconds),
  }), "subtle");
  const now = document.createElement("div");
  now.setAttribute("aria-live", "polite");
  const list = document.createElement("ol");
  list.className = "recording-steps";
  const items = frames.map((frame, n) => {
    const item = plain("li", `${frameLabel(frame)} — ${formatNumber(frame.at / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`);
    item.tabIndex = 0;
    item.addEventListener("click", () => { stop(); show(n); });
    list.append(item);
    return item;
  });
  const show = (n) => {
    index = Math.max(0, Math.min(frames.length - 1, n));
    items.forEach((item, i) => {
      if (i === index) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
      item.style.background = i === index ? "var(--selected)" : "";
    });
    now.replaceChildren(plain("strong", frameLabel(frames[index])), plain("p", frames[index].detail, "subtle"));
  };
  const play = button("recordings.play", "Play", "quiet-button", () => {
    if (timer) return stop();
    if (index >= frames.length - 1) show(0);
    play.textContent = say("recordings.pause", "Pause");
    tick();
  });
  function stop() { clearTimeout(timer); timer = null; play.textContent = say("recordings.play", "Play"); }
  function tick() {
    if (index >= frames.length - 1) return stop();
    const wait = Math.min(2000, Math.max(150, frames[index + 1].at - frames[index].at));
    timer = setTimeout(() => { show(index + 1); tick(); }, wait);
  }
  const back = button("recordings.back", "Step back", "quiet-button", () => { stop(); show(index - 1); });
  const next = button("recordings.next", "Step on", "quiet-button", () => { stop(); show(index + 1); });
  const row = document.createElement("div");
  row.className = "identity-actions";
  row.append(play, back, next);
  show(0);
  return [counts, row, now, list];
}

function pathBlock(svgText) {
  const details = document.createElement("details");
  details.append(make("summary", "", "recordings.path", "The path it took"));
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg && svg.nodeName === "svg") {
    svg.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
    const box = document.createElement("div");
    box.style.overflow = "hidden";
    box.append(document.importNode(svg, true));
    details.append(box);
  }
  return [details];
}

function boxWords(monitor) {
  if (!monitor.vertices.length) return [];
  const total = monitor.usage.total;
  return [plain("p", say("recordings.box-words", `${monitor.vertices.length} flow boxes; ${total.input + total.output} words of context used in all.`, {
    boxes: formatNumber(monitor.vertices.length), words: formatNumber(total.input + total.output),
  }), "subtle")];
}

function keepers(runId) {
  const said = status();
  const page = button("recordings.save-page", "Save as a page", "quiet-button", async () => {
    try { await downloadPage(runId); said.textContent = say("recordings.page-saved", "The page was saved to your downloads."); }
    catch (error) { said.textContent = error.message; }
  });
  const flow = button("recordings.make-flow", "Make a workflow from it", "quiet-button", async () => {
    try {
      const made = await api(`runs/${runId}/recording/flow`, {});
      said.textContent = say("recordings.flow-made", `Saved "${made.workflow.name}" with ${made.steps} steps under Automations.`, { name: made.workflow.name, steps: formatNumber(made.steps) });
    } catch (error) { said.textContent = error.message; }
  });
  const row = document.createElement("div");
  row.className = "identity-actions";
  row.append(page, flow);
  return [row, said];
}

async function downloadPage(runId) {
  const response = await fetch(`/api/runs/${runId}/recording/page?lang=${encodeURIComponent(language())}`, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Request failed");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = `task-recording-${runId.slice(0, 8)}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

async function drawRecordings() {
  let state;
  try { state = await api("recordings"); } catch { return; }
  const card = recordingsCard(state);
  const old = $("recordings-card");
  if (old) old.replaceWith(card); else document.body.append(card);
}

/* ------------------------------------------------------------ Is Branch keeping up */

function loopCard(state) {
  const card = make("section", "card");
  card.id = "event-loop-card";
  card.dataset.home = "settings:advanced";
  card.append(make("h2", "", "event-loop.title", "Is Branch keeping up"),
    make("p", "subtle", "event-loop.purpose", "Measures whether Branch's own work is starting on time, so a frozen window or a late chat reply can be traced to Branch itself."));
  const label = make("label", "", "event-loop.switch", "The check");
  label.htmlFor = "event-loop-mode";
  const select = switchSelect("event-loop-mode", state.settings.mode);
  const reading = plain("p", state.reading ? readingWords(state.reading) : "", "subtle");
  reading.id = "event-loop-reading";
  const said = status();
  const save = button("action.save", "Save", "", async () => {
    try { const next = await api("event-loop", { mode: select.value }); reading.textContent = next.reading ? readingWords(next.reading) : ""; said.textContent = say("recordings.saved", "Saved."); }
    catch (error) { said.textContent = error.message; }
  });
  const check = button("event-loop.check", "Check now", "quiet-button", async () => {
    try { const next = await api("event-loop?read=1"); reading.textContent = next.reading ? readingWords(next.reading) : say("event-loop.off", "The check is off."); }
    catch (error) { said.textContent = error.message; }
  });
  const row = document.createElement("div");
  row.className = "identity-actions";
  row.append(save, check);
  card.append(label, select, reading, row, said);
  return card;
}

function readingWords(reading) {
  const key = `event-loop.${reading.verdict}`;
  return say(key, reading.words, {
    p99: formatNumber(Math.round(reading.delay.p99)), busy: formatNumber(Math.round(reading.busy * 100)),
  }) + " " + say("event-loop.stalls", `Stalls counted: ${reading.stalls}.`, { stalls: formatNumber(reading.stalls) });
}

async function drawLoop() {
  let state;
  try { state = await api("event-loop"); } catch { return; }
  const card = loopCard(state);
  const old = $("event-loop-card");
  if (old) old.replaceWith(card); else document.body.append(card);
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}

whenReady(() => { void drawRecordings(); void drawLoop(); });
