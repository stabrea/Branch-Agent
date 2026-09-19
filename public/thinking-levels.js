// Redesign phase 2 (accounts, critique #22): the Thinking lists offer only the levels the chosen
// model really takes. The server says which (src/thinking-levels.ts, `thinking` on each model in
// /api/state); app.js hands over the list and the conversation's choice (`branch-models`,
// `branch-session-model`). A saved level the model does not take is kept and marked, never cleared.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
let models = null;
let session = null;

/** The words for one level: an effort for OpenAI-shaped models, a thinking budget for Claude. */
function words(how, level) {
  if (!level) return t(how === "budget" ? "thinking.level.off" : "thinking.level.default");
  return t(`thinking.${how === "budget" ? "budget" : "effort"}.${level}`);
}
function presetById(id) {
  return models?.presets?.find((preset) => preset.id === id) ?? null;
}
/** The note under a list: what this model does with a thinking level. */
function noteFor(select) {
  const id = `${select.id}-thinking-note`;
  let note = $(id);
  if (!note) {
    note = document.createElement("p");
    note.id = id;
    note.className = "field-note thinking-note";
    select.insertAdjacentElement("afterend", note);
  }
  return note;
}

/** Redraws one Thinking list for one model, keeping the value it holds. */
export function applyThinking(select, preset, emptyWords, saved) {
  if (!select || !preset) return;
  const thinking = preset.thinking ?? { how: "none", levels: [] };
  // The list may have been drawn for another model, so the saved value is passed in when known.
  const held = saved ?? select.value;
  const levels = thinking.levels ?? [];
  const shown = ["", ...levels];
  if (held && !levels.includes(held)) shown.push(held);
  const options = shown.map((level) => {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level && !levels.includes(level)
      ? t("thinking.level.unused", { level: words("effort", level) })
      : level ? words(thinking.how, level) : (emptyWords ?? words(thinking.how, ""));
    return option;
  });
  select.replaceChildren(...options);
  select.value = held;
  select.dataset.thinking = thinking.how;
  const note = noteFor(select);
  note.textContent = thinking.how === "none" ? t("thinking.note.none", { model: preset.model })
    : held && !levels.includes(held) ? t("thinking.note.unused", { model: preset.model })
      : thinking.how === "budget" ? t("thinking.note.budget") : "";
  note.hidden = !note.textContent;
}

function defaultPreset() {
  return presetById(models?.activePreset) ?? presetById(models?.defaultPreset) ?? models?.presets?.[0] ?? null;
}
/** `keep` is true when the person changed the model here: their unsaved pick of level stays. */
function drawDefaults(keep = false) {
  const select = $("models-reasoning");
  if (!select || !models) return;
  const saved = keep || document.activeElement === select ? undefined : models.reasoning ?? "";
  applyThinking(select, presetById($("models-active")?.value) ?? defaultPreset(), undefined, saved);
}
function drawSession() {
  const select = $("session-reasoning");
  if (!select || !models) return;
  const chosen = $("session-model")?.value || session?.effective?.presetId || session?.preset;
  applyThinking(select, presetById(chosen) ?? defaultPreset(), t("thinking.level.workspace"), session ? session.reasoning ?? "" : undefined);
}
function drawAll() {
  drawDefaults();
  drawSession();
}

document.addEventListener("branch-models", (event) => { models = event.detail ?? models; drawAll(); });
document.addEventListener("branch-session-model", (event) => { session = event.detail ?? null; drawSession(); });
document.addEventListener("branch-language", drawAll);
$("models-active")?.addEventListener("change", () => drawDefaults(true));
$("session-model")?.addEventListener("change", drawSession);
if (globalThis.branchModelsNow) { models = globalThis.branchModelsNow; drawAll(); }
globalThis.branchThinking = { applyThinking, redraw: drawAll };
