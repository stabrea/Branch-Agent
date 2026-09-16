/**
 * Models on this computer. Shows what Ollama and LM Studio hold, what this computer could
 * comfortably run, downloads a model with a progress bar, and keeps the task routing rules.
 * Kept in its own file; the page only provides the empty section.
 */
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const gb = (bytes) => `${Math.round((Number(bytes) / 1024 ** 3) * 10) / 10} GB`;
let watching = null;

function suggestion(entry, onGet) {
  const node = el("div", undefined, "item");
  const titles = { small: "Small and quick", medium: "A steady all-rounder", large: "Slow but thoughtful" };
  node.append(el("h3", `${titles[entry.size]} — ${entry.model}`));
  node.append(el("p", entry.expectation));
  node.append(el("p", `${entry.note} About ${gb(entry.downloadBytes)} to download.`, "meta"));
  const get = el("button", entry.fits ? "Get this one" : "Get it anyway");
  get.type = "button";
  get.addEventListener("click", () => onGet(entry.model));
  node.append(get);
  return node;
}

function download(entry) {
  const node = el("div", undefined, "item");
  node.append(el("h3", entry.model));
  const bar = document.createElement("progress");
  bar.max = 100;
  bar.value = entry.percent;
  node.append(bar);
  const size = entry.total ? ` — ${gb(entry.completed)} of ${gb(entry.total)}` : "";
  node.append(el("p", entry.error ? `Did not finish: ${entry.error}` : `${entry.status}${size} (${entry.percent}%)`));
  if (!entry.finishedAt) {
    const stop = el("button", "Stop this download");
    stop.type = "button";
    stop.addEventListener("click", () => act("local-models/stop", { model: entry.model }, "Stopping…"));
    node.append(stop);
  }
  return node;
}

function installed(model) {
  const node = el("div", undefined, "item");
  node.append(el("h3", model.name));
  const pictures = model.canSeePictures ? "Can be shown a picture." : "Words only.";
  node.append(el("p", `${gb(model.size)} on disk${model.parameterSize ? ` · ${model.parameterSize}` : ""}${model.family ? ` · ${model.family}` : ""}. ${pictures}`));
  const remove = el("button", "Remove it");
  remove.type = "button";
  remove.addEventListener("click", () => act("local-models/remove", { model: model.name }, `Removed ${model.name}.`));
  node.append(remove);
  return node;
}

async function act(path, body, message) {
  try {
    await api(path, body);
    toast(message);
    await draw();
  } catch (error) { toast(error.message); }
}

function drawRouting(routing) {
  $("local-routing-enabled").checked = routing.enabled;
  $("local-routing-private").checked = routing.localForPrivate;
  $("local-routing-hard").checked = routing.cloudForHard;
  $("local-routing-ceiling").value = routing.costCeilingDollars;
}

function summarise(view) {
  const parts = [];
  parts.push(view.ollama.installed
    ? `Ollama is running (version ${view.ollama.version}) with ${view.ollama.models.length} model(s) ready.`
    : "Ollama is not installed or not started yet.");
  if (view.lmStudio.running) parts.push(`LM Studio is running with ${view.lmStudio.models.length} model(s).`);
  if (view.lastError) parts.push(`Last problem: ${view.lastError.what}`);
  return parts.join(" ");
}

async function draw() {
  let view;
  try { view = await api("local-models"); } catch (error) { $("local-models-state").textContent = error.message; return; }
  $("local-models-hardware").textContent = `This computer: ${view.hardware.summary}.`;
  $("local-models-state").textContent = summarise(view);
  if (!view.ollama.installed) {
    const link = el("a", "Download Ollama (free)");
    link.href = view.ollama.downloadPage;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    $("local-models-state").append(" ", link);
  }
  const start = (model) => act("local-models/pull", { model }, `Getting ${model}. This can take several minutes.`);
  $("local-models-suggestions").replaceChildren(...view.recommendations.map((entry) => suggestion(entry, start)));
  $("local-models-downloads").replaceChildren(...view.downloads.map(download));
  $("local-models-installed").replaceChildren(...view.ollama.models.map(installed));
  drawRouting(view.routing);
  const busy = view.downloads.some((entry) => !entry.finishedAt);
  if (busy && !watching) watching = setInterval(() => void draw(), 2000);
  if (!busy && watching) { clearInterval(watching); watching = null; }
}

if ($("local-models-card")) {
  $("local-model-get").addEventListener("click", () => {
    const model = $("local-model-name").value.trim();
    if (!model) { toast("Type the name of a model first, for example llama3.2:3b"); return; }
    void act("local-models/pull", { model }, `Getting ${model}. This can take several minutes.`);
  });
  $("local-routing-save").addEventListener("click", () => void act("local-models/routing", {
    enabled: $("local-routing-enabled").checked,
    localForPrivate: $("local-routing-private").checked,
    cloudForHard: $("local-routing-hard").checked,
    costCeilingDollars: Number($("local-routing-ceiling").value) || 0,
  }, "Saved."));
  void draw();
}
