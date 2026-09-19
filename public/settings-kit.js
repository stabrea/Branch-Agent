/**
 * R17-S-A: understandable settings, in four cards.
 *
 *   Start from a preset       (settings:general)  a whole-app preset, with every change shown first
 *   Put settings back         (settings:general)  one setting or all of them, with the same view
 *   Your settings in one file (settings:data)     save a copy, or bring one in and see what it changes
 *   Which file does what      (settings:general)  the files you write, what each is for, and editing them
 *
 * The three that change settings share one view: every change on its own line with a tick box,
 * changes that make Branch less careful marked and left unticked, and a separate "Yes, make it
 * less careful" box that the server also insists on. Nothing is written until "Make the ticked
 * changes" is pressed, and then only the ticked lines (src/settings-kit/changes.ts).
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const say = (key, english, values) => {
  const words = t(key, values);
  return words === key ? english.replace(/\{(\w+)\}/g, (whole, name) => (values && name in values ? String(values[name]) : whole)) : words;
};
function el(tag, key, english, className) {
  const node = document.createElement(tag);
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  else if (english !== undefined) node.textContent = english;
  if (className) node.className = className;
  return node;
}
function card(id, home, title, purpose) {
  document.getElementById(id)?.remove();
  const section = el("section", undefined, undefined, "card");
  section.id = id;
  section.dataset.home = home;
  section.append(el("h2", ...title), el("p", ...purpose));
  return section;
}
/** A control with its caption before it and its one-sentence description after it. */
function field(id, control, caption, description) {
  control.id = id;
  const label = el("label", ...caption);
  label.htmlFor = id;
  const note = el("p", ...description, "field-note");
  note.id = `${id}-note`;
  control.setAttribute("aria-describedby", note.id);
  return [label, control, note];
}
function quiet(key, english, onClick) {
  const node = el("button", key, english, "quiet-button");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/* ---------- words for values ---------- */

const VALUE_WORDS = {
  off: ["field.switch-off", "Off"], on: ["field.switch-on", "On"], "when-needed": ["field.switch-when-needed", "Only when it is needed"],
  true: ["settings-kit.value.yes", "Yes"], false: ["settings-kit.value.no", "No"],
};
const CHOICE_WORDS = {
  "policy.preset": { "read-only": "Read only", "ask-before-changes": "Ask before changes", workspace: "Just do it inside my workspace", off: "No approvals", custom: "Your own rules" },
  "policy.unmatchedCommands": { ask: "Ask first", allow: "Let it through" },
  "os-sandbox.network": { none: "Nowhere", limited: "Only reading from sites you allow", "per-site": "Sites you allow", open: "Anywhere" },
  // mac7/bind: where Branch's own door listens.
  "listen-address.where": { "this-computer": "This computer only", "private-network": "The private network this computer is on" },
};
function valueWords(change, value) {
  const choices = CHOICE_WORDS[`${change.key}.${change.field}`];
  // Own keys only: a saved value such as "constructor" must not reach the object's prototype.
  if (choices && Object.hasOwn(choices, value)) return say(`settings-kit.value.${change.key}.${change.field}.${value}`, choices[value]);
  const pair = Object.hasOwn(VALUE_WORDS, String(value)) ? VALUE_WORDS[String(value)] : null;
  return pair ? say(...pair) : String(value);
}

/* ---------- the shared "what would change" view ---------- */

function changeRow(change, index) {
  const row = el("label", undefined, undefined, "kit-change");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = change.id;
  box.checked = !change.loosens;
  box.id = `kit-change-${change.id.replace(/[^a-z0-9]/gi, "-")}-${index}`;
  const words = el("span", undefined, `${say(change.nameT, change.name)} · ${say(change.labelT, change.label)}: ${valueWords(change, change.from)} → ${valueWords(change, change.to)}`);
  row.append(box, words);
  if (change.loosens) row.append(el("strong", "settings-kit.loosens", "Makes Branch less careful", "kit-loose"));
  return row;
}

/** Draws the changes a plan would make into `holder`, with the one filled button that makes them. */
async function showPlan(holder, plan, status) {
  holder.replaceChildren();
  status.textContent = "";
  let preview;
  try { preview = await api("settings-kit/preview", plan); } catch (error) { status.textContent = error.message; return; }
  if (!preview.changes.length) {
    holder.append(el("p", "settings-kit.nothing", "Nothing would change: your settings already match.", "subtle"));
    return;
  }
  const list = el("div", undefined, undefined, "kit-changes");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", say("settings-kit.changes", "What would change"));
  list.append(...preview.changes.map(changeRow));
  const tick = el("p", "settings-kit.tick", "Untick anything you do not want. Only the ticked lines are changed.", "field-note");
  tick.id = `kit-tick-${Math.random().toString(36).slice(2, 8)}`;
  for (const box of list.querySelectorAll("input")) box.setAttribute("aria-describedby", tick.id);
  holder.append(tick, list);
  if (preview.refused.length)
    holder.append(el("p", undefined, `${say("settings-kit.refused", "Left out, because they cannot be changed from here:")} ${preview.refused.join("; ")}`, "subtle"));
  const loose = preview.changes.some((change) => change.loosens);
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  if (loose) holder.append(...confirmRow(confirm));
  const go = el("button", "settings-kit.apply", "Make the ticked changes");
  go.type = "button";
  go.addEventListener("click", () => applyPlan({ holder, plan, list, confirm, status, go }));
  holder.append(go);
}

function confirmRow(confirm) {
  const row = el("label", undefined, undefined, "kit-confirm");
  confirm.id = `kit-confirm-${Math.random().toString(36).slice(2, 8)}`;
  row.append(confirm, el("span", "settings-kit.confirm", "Yes, make it less careful"));
  const note = el("p", "settings-kit.confirm-note",
    "The lines marked above let Branch do more without asking, or take a protection away. They are only changed if this is ticked as well.", "field-note");
  note.id = `${confirm.id}-note`;
  confirm.setAttribute("aria-describedby", note.id);
  return [row, note];
}

async function applyPlan({ holder, plan, list, confirm, status, go }) {
  const accept = [...list.querySelectorAll("input:checked")].map((box) => box.value);
  go.disabled = true;
  try {
    const result = await api("settings-kit/apply", { plan, accept, confirmLoosening: confirm.checked });
    holder.replaceChildren();
    status.textContent = say("settings-kit.done", "{count} changed. A card you already had open may show its old value until the window is reloaded.", { count: result.applied.length });
    document.dispatchEvent(new CustomEvent("branch-settings-changed", { detail: { applied: result.applied } }));
    for (const ready of ["branchContextFilesReady", "branchSecurityCheckReady", "branchLearningCoreReady", "branchVoiceReady"])
      globalThis[ready]?.();
  } catch (error) {
    status.textContent = error.message;
  } finally { go.disabled = false; }
}

function planArea() {
  const holder = el("div", undefined, undefined, "kit-plan");
  const status = el("p", undefined, undefined, "meta");
  status.setAttribute("role", "status");
  return { holder, status };
}

/* ---------- the cards ---------- */

function presetCard(overview) {
  const section = card("settings-kit-presets", "settings:general",
    ["settings-kit.card.presets", "Start from a preset"],
    ["settings-kit.card.presets-purpose", "Set many switches at once for the way you want to work. You see every change first and choose which to make."]);
  const select = document.createElement("select");
  for (const preset of overview.presets) {
    const option = el("option", preset.t, preset.name);
    option.value = preset.id;
    select.append(option);
  }
  const about = el("p", undefined, undefined, "subtle");
  const describe = () => {
    const preset = overview.presets.find((entry) => entry.id === select.value);
    if (preset) { about.dataset.t = preset.aboutT; about.textContent = say(preset.aboutT, preset.about); }
  };
  select.addEventListener("change", describe);
  describe();
  const { holder, status } = planArea();
  section.append(...field("kit-preset", select, ["settings-kit.field.preset", "Preset"],
    ["describe.kit-preset", "Choosing one changes nothing yet. Press the button below to see what it would change."]),
  about, quiet("settings-kit.show", "Show what would change", () => showPlan(holder, { source: "preset", preset: select.value }, status)), holder, status);
  return section;
}

function resetCard(overview) {
  const section = card("settings-kit-reset", "settings:general",
    ["settings-kit.card.reset", "Put settings back"],
    ["settings-kit.card.reset-purpose", "Put one setting, or all of them, back to how they were when Branch was new. Your conversations, files, keys and connections are not touched."]);
  const select = document.createElement("select");
  const all = el("option", "settings-kit.everything", "Everything on this list");
  all.value = "";
  select.append(all, ...overview.settings.map((spec) => { const option = el("option", spec.t, spec.name); option.value = spec.key; return option; }));
  const { holder, status } = planArea();
  const plan = () => (select.value ? { source: "reset", key: select.value } : { source: "reset" });
  section.append(...field("kit-reset-what", select, ["settings-kit.field.reset", "What to put back"],
    ["describe.kit-reset", "Choosing changes nothing yet. Press the button below to see each value before and after."]),
  quiet("settings-kit.show", "Show what would change", () => showPlan(holder, plan(), status)), holder, status);
  return section;
}

function fileCard() {
  const section = card("settings-kit-file", "settings:data",
    ["settings-kit.card.file", "Your settings in one file"],
    ["settings-kit.card.file-purpose", "Keep your settings and switches in one small file, or bring them to another computer. Keys, passwords, connections and people are never in it."]);
  const { holder, status } = planArea();
  const save = quiet("settings-kit.save-copy", "Save a copy", async () => {
    try {
      const file = await api("settings-kit/export");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
      link.download = "branch-settings.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) { status.textContent = error.message; }
  });
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const chosen = input.files?.[0];
    if (!chosen) return;
    if (chosen.size > 256 * 1024) { status.textContent = say("settings-kit.too-big", "That file is larger than a settings file can be."); return; }
    await showPlan(holder, { source: "import", file: await chosen.text() }, status);
  });
  section.append(save, ...field("kit-import", input, ["settings-kit.field.import", "Bring in a settings file"],
    ["describe.kit-import", "Nothing changes when you choose a file. You see what it would change, and choose."]), holder, status);
  return section;
}

/* ---------- which file does what: public/agent-files.js (phase2/accounts) draws it now ---------- */

/* The look of the changes, files and editor lives in public/settings-kit.css (the page's Content Security Policy refuses an inline <style>). */

export async function drawKit() {
  let overview;
  try { overview = await api("settings-kit"); } catch { return; }
  document.body.append(presetCard(overview), resetCard(overview), fileCard());
  await globalThis.branchAgentFiles?.draw(); // phase2/accounts: the assistant's files, with an editor and undo
  globalThis.branchDescribeSettings?.();
}

if (typeof document !== "undefined") {
  globalThis.branchSettingsKitReady = () => { drawKit().catch(() => {}); };
  document.addEventListener("branch-language", () => { drawKit().catch(() => {}); });
  drawKit().catch(() => {});
}
