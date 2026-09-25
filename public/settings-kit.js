/**
 * R17-S-A: understandable settings, in four cards.
 *
 *   Start from a preset       (settings:general)  a whole-app preset, with every change shown first
 *   Put settings back         (settings:general)  one setting or all of them, with the same view
 *   Your settings in one file (settings:data)     save a copy, or bring one in and see what it changes
 *   Which file does what      (settings:general)  the files you write, what each is for, and editing them
 *   Recent changes            (settings:general)  what changed, undo one change, and why a setting is as it is (Q48/Q49)
 *
 * The three that change settings share one view: every change on its own line with a tick box,
 * changes that make Branch less careful marked and left unticked, and a separate "Yes, make it
 * less careful" box that the server also insists on. Nothing is written until "Make the ticked
 * changes" is pressed, and then only the ticked lines (src/settings-kit/changes.ts).
 */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

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
  off: ["field.switch-off", "Off"], on: ["field.switch-on", "On"], "when-needed": ["field.switch-when-needed", "When needed"],
  true: ["settings-kit.value.yes", "Yes"], false: ["settings-kit.value.no", "No"],
};
const CHOICE_WORDS = {
  "policy.preset": { "read-only": "Read only", careful: "Careful", "ask-before-changes": "Ask before changes", workspace: "Just do it inside my workspace", off: "No approvals", custom: "Your own rules" },
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
    // Q65 review: a setting that cannot be changed from here says why, even when nothing else would change.
    if (preview.refused.length)
      holder.append(el("p", undefined, `${say("settings-kit.refused", "Left out, because they cannot be changed from here:")} ${preview.refused.join("; ")}`, "subtle"));
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

function confirmRow(confirm, words = ["settings-kit.confirm-note",
  "The lines marked above let Branch do more without asking, or take a protection away. They are only changed if this is ticked as well."]) {
  const row = el("label", undefined, undefined, "kit-confirm");
  confirm.id = `kit-confirm-${Math.random().toString(36).slice(2, 8)}`;
  row.append(confirm, el("span", "settings-kit.confirm", "Yes, make it less careful"));
  const note = el("p", ...words, "field-note");
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
  const presetOptions = overview.presets.map((preset) => [preset.id, preset.t, preset.name]);
  const select = dropdown({
    id: "kit-preset",
    options: presetOptions.length > 0 ? presetOptions : [["", "No presets"]],
    value: presetOptions.length > 0 ? presetOptions[0][0] : ""
  });
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
  const resetOptions = [["", "settings-kit.everything", "Everything on this list"], ...overview.settings.map((spec) => [spec.key, spec.t, spec.name])];
  const select = dropdown({
    id: "kit-reset-what",
    options: resetOptions,
    value: ""
  });
  const { holder, status } = planArea();
  const plan = () => (select.value ? { source: "reset", key: select.value } : { source: "reset" });
  section.append(...field("kit-reset-what", select, ["settings-kit.field.reset", "What to put back"],
    ["describe.kit-reset", "Choosing changes nothing yet. Press the button below to see each value before and after."]),
  quiet("settings-kit.show", "Show what would change", () => showPlan(holder, plan(), status)), holder, status);
  section.append(...putBackRows(overview, status));
  return section;
}

/**
 * Q65 review: a setting whose saved record cannot be read (voice) cannot be changed from here or from its own
 * card, so it is offered back as Branch ships it, the whole record at once, with the reason beside it.
 */
function putBackRows(overview, status) {
  return overview.settings.filter((spec) => spec.refused && spec.canPutBack).flatMap((spec) => {
    const why = el("p", undefined, spec.refused, "field-note");
    // Q83: what is shipped may be less careful than what the unreadable record held, and then this asks too.
    const confirm = document.createElement("input");
    confirm.type = "checkbox";
    const asks = confirmRow(confirm);
    const button = quiet(`settings-kit.put-back.${spec.key}`, `Put ${spec.name.toLowerCase()} settings back as shipped`, async () => {
      button.disabled = true;
      try {
        await api("settings-kit/put-back", { key: spec.key, confirmLoosening: confirm.checked });
        why.remove();
        for (const node of asks) node.remove();
        button.remove();
        status.textContent = say("settings-kit.put-back-done", "Put back as shipped.");
        globalThis.branchVoiceReady?.();
      } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    return [why, ...asks, button];
  });
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

/* ---------- Q48/Q49: recent changes, undo, and why a setting is as it is ---------- */

const HOW_WORDS = {
  switch: ["settings-kit.how.switch", "you, moving the switch in Settings"],
  preset: ["settings-kit.how.preset", "a preset"],
  reset: ["settings-kit.how.reset", "putting settings back to how they started"],
  import: ["settings-kit.how.import", "a settings file you brought in"],
  talk: ["settings-kit.how.talk", "a conversation, when you asked for it"],
  undo: ["settings-kit.how.undo", "undoing an earlier change"],
  card: ["settings-kit.how.card", "you, on its own card in Settings"],
  command: ["settings-kit.how.command", "a command you typed"],
  lockdown: ["settings-kit.how.lockdown", "Lockdown"],
  unknown: ["settings-kit.how.unknown", "a change whose source was not recorded"],
};
/* A preset's record keeps its English name; it is shown in the window's language, like on the preset card. */
function detailWords(record, presets) {
  if (record.source === "command") return record.detail;
  if (record.source !== "preset") return "";
  const preset = presets.find((entry) => entry.name === record.detail || entry.id === record.detail);
  return preset ? say(preset.t, preset.name) : record.detail;
}
const howWords = (record, presets) => {
  const pair = Object.hasOwn(HOW_WORDS, record.source) ? HOW_WORDS[record.source] : HOW_WORDS.unknown;
  const detail = detailWords(record, presets);
  return `${say(...pair)}${detail ? ` (${detail})` : ""}`;
};
const when = (iso) => new Date(iso).toLocaleString();

function fieldsOf(overview) {
  const map = new Map();
  for (const spec of overview.settings)
    for (const one of spec.fields) map.set(`${spec.key}.${one.field}`, { key: spec.key, field: one.field, words: `${say(spec.t, spec.name)} · ${say(one.t, one.label)}` });
  return map;
}

function whyWords(answer, presets) {
  const value = valueWords(answer, answer.value);
  if (answer.kind === "starting-value") return say("settings-kit.why.starting", "It is {value}, how it starts. No change to it was recorded.", { value });
  if (answer.kind === "not-recorded") return say("settings-kit.why.not-recorded", "It is {value}. Nothing was recorded about who or what set it.", { value });
  const how = howWords(answer.record, presets), at = when(answer.record.at);
  if (answer.kind === "changed-since")
    return say("settings-kit.why.changed-since", "It is {value}. The last recorded change set it to {after} ({how}, {when}), but it was changed again since by something that keeps no record.",
      { value, after: valueWords(answer, answer.record.after), how, when: at });
  return say("settings-kit.why.recorded", "It is {value}, set by {how} on {when}.", { value, how, when: at });
}

function recordRow(record, fields, presets, confirm, status, redraw) {
  const row = el("li", undefined, undefined, "kit-record");
  const lines = record.changes.map((entry) => {
    const known = fields.get(entry.setting) ?? { key: "", field: "", words: entry.setting };
    return `${known.words}: ${valueWords(known, entry.before)} → ${valueWords(known, entry.after)}`;
  });
  row.append(el("p", undefined, `${when(record.at)} · ${howWords(record, presets)}`, "meta"), el("p", undefined, lines.join("; ")));
  // Lockdown puts back what it changed when it is turned off, so its own changes have no undo here.
  if (record.source === "lockdown") { row.append(el("p", "settings-kit.history.lockdown", "Turning Lockdown off or on is how this is changed.", "subtle")); return row; }
  if (record.undoneBy) { row.append(el("p", "settings-kit.history.undone", "Undone.", "subtle")); return row; }
  row.append(quiet("settings-kit.history.undo", "Undo this change", async () => {
    try {
      const result = await api("settings-kit/undo", { record: record.id, confirmLoosening: confirm.checked });
      status.textContent = say("settings-kit.done", "{count} changed. A card you already had open may show its old value until the window is reloaded.", { count: result.applied.length });
      document.dispatchEvent(new CustomEvent("branch-settings-changed", { detail: { applied: result.applied } }));
      await redraw();
    } catch (error) { status.textContent = error.message; }
  }));
  return row;
}

async function drawRecords(list, fields, presets, confirm, status) {
  let history;
  try { history = await api("settings-kit/history"); } catch (error) { status.textContent = error.message; return; }
  const redraw = () => drawRecords(list, fields, presets, confirm, status);
  list.replaceChildren(...history.records.slice(0, 10).map((record) => recordRow(record, fields, presets, confirm, status, redraw)));
  if (!history.records.length) list.append(el("li", "settings-kit.history.none", "No changes have been recorded yet.", "subtle"));
}

function historyCard(overview) {
  const section = card("settings-kit-history", "settings:general",
    ["settings-kit.card.history", "Recent changes"],
    ["settings-kit.card.history-purpose", "Changes made on these cards or in a conversation are written down. Undo one to put back exactly what it changed, or ask why a setting is set the way it is."]);
  const fields = fieldsOf(overview);
  const { holder, status } = planArea();
  const select = dropdown({ id: "kit-why", options: [...fields].map(([id, known]) => [id, known.words]), value: [...fields.keys()][0] ?? "" });
  const answer = el("p", undefined, undefined, "subtle");
  answer.setAttribute("role", "status");
  const ask = quiet("settings-kit.why.ask", "Why is it set like this?", async () => {
    try { answer.textContent = whyWords({ ...fields.get(select.value), ...(await api(`settings-kit/why/${encodeURIComponent(select.value)}`)) }, overview.presets); }
    catch (error) { answer.textContent = error.message; }
  });
  const list = el("ul", undefined, undefined, "kit-records");
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  holder.append(list, ...confirmRow(confirm, ["settings-kit.history.confirm-note",
    "An undo that puts back a value letting Branch do more without asking, or taking a protection away, is only made if this is ticked as well."]));
  section.append(...field("kit-why", select, ["settings-kit.field.why", "Setting"],
    ["describe.kit-why", "Says who or what last set it, from what was written down. Nothing is changed."]), ask, answer, holder, status);
  drawRecords(list, fields, overview.presets, confirm, status).catch(() => {});
  return section;
}

/* ---------- which file does what: public/agent-files.js (phase2/accounts) draws it now ---------- */

/* The look of the changes, files and editor lives in public/settings-kit.css (the page's Content Security Policy refuses an inline <style>). */

export async function drawKit() {
  let overview;
  try { overview = await api("settings-kit"); } catch { return; }
  document.body.append(presetCard(overview), resetCard(overview), fileCard(), historyCard(overview));
  await globalThis.branchAgentFiles?.draw(); // phase2/accounts: the assistant's files, with an editor and undo
  globalThis.branchDescribeSettings?.();
}

if (typeof document !== "undefined") {
  globalThis.branchSettingsKitReady = () => { drawKit().catch(() => {}); };
  document.addEventListener("branch-language", () => { drawKit().catch(() => {}); });
  drawKit().catch(() => {});
}
