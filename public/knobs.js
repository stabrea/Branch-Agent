/**
 * R17-S-B: the knobs that used to be hidden, each with a plain label and a sentence saying what it
 * does. The values live on the server (src/knobs/); this file only shows them and sends changes back.
 *
 * Each card says where it lives with `data-home` (docs/places.md), has one filled Save button and a
 * quiet "Put back as shipped" button that restores only its own fields. Every control is described
 * by the sentence right after it, linked with aria-describedby. Every word is behind a key.
 */
import { t, formatNumber } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
let shown = null;
let stateVersion = 0;
let writesInFlight = 0;
const cardWriteVersions = new Map();

function beginWrite(card) {
  const version = (cardWriteVersions.get(card) ?? 0) + 1;
  cardWriteVersions.set(card, version);
  stateVersion += 1;
  writesInFlight += 1;
  return version;
}
const writeIsCurrent = (card, version) => cardWriteVersions.get(card) === version;
function finishWrite() {
  writesInFlight -= 1;
  stateVersion += 1;
  if (!writesInFlight) void refresh();
}

async function api(body, path = "knobs") {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("knobs.failed"));
  return data;
}

function keyed(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

/* The fields of each card. `card` is the server's record; `def` is how Branch ships. */
const num = (name, min, max, def, extra = {}) => ({ name, kind: "number", min, max, def, ...extra });
const auto = (name, min, max, launched, extra = {}) => num(name, min, max, null, { nullable: true, launched, ...extra });
const CARDS = [
  { id: "compaction", card: "compaction", home: "settings:models:defaults", fields: [
    { name: "autoCompact", kind: "switch", def: true },
    auto("compactAtPercent", 20, 95, null), num("keepRecentMessages", 2, 40, 6),
    auto("contextWindowTokens", 8000, 2000000, "contextWindowTokens")] },
  { id: "limits", card: "limits", home: "settings:permissions", fields: [
    num("maxSteps", 1, 500, 60), auto("spendCapDollars", 0.01, 10000, null, { step: "0.01" })] },
  { id: "retries", card: "limits", home: "settings:advanced", fields: [auto("apiRetries", 0, 5, "apiRetries"),
    auto("localFirstReplySeconds", 5, 1800, "localFirstReplySeconds"),
    auto("maxModelRounds", 2, 60, "maxModelRounds")] },
  { id: "tools", card: "commands", home: "settings:advanced", fields: [
    auto("toolAnswerChars", 1000, 60000, "toolAnswerChars"), auto("toolTimeoutSeconds", 5, 600, "toolTimeoutSeconds")] },
  // DG-025: on Settings › Computer & browser this card saves as you go, as the sample does (asYouGo).
  { id: "commands", card: "commands", home: "settings:computer", warn: "knobs.warn.environment", asYouGo: true, fields: [
    auto("commandTimeoutSeconds", 1, 120, null), { name: "keptOpenShell", kind: "switch", def: true },
    { name: "passEnvironment", kind: "lines", def: [] }] },
  { id: "subtasks", card: "subtasks", home: "settings:models:defaults", fields: [
    { name: "subtaskModel", kind: "connection", def: null }, { name: "sideJobModel", kind: "connection", def: null },
    num("parallelSubtasks", 1, 8, 4), num("subtaskTimeoutSeconds", 1, 120, 120)] },
  { id: "reasoning", card: "reasoning", home: "settings:models:defaults", fields: [
    { name: "effortByModel", kind: "efforts", def: {} },
    { name: "serviceTier", kind: "select", def: "standard", options: ["standard", "priority", "flex"] }] },
  { id: "show-reasoning", card: "reasoning", home: "settings:appearance", fields: [{ name: "showReasoning", kind: "switch", def: true }] },
  { id: "memory", card: "memory", home: "library:memory", fields: [
    num("snapshotFacts", 0, 200, 20), num("snapshotChars", 0, 40000, 2000),
    { name: "memoryProvider", kind: "select", def: "branch", options: ["branch", "branch-and-hindsight"], outside: true },
    { name: "aboutYouOn", kind: "switch", def: false }, { name: "aboutYou", kind: "text", def: "" },
    num("aboutYouChars", 100, 8000, 1500)] },
  { id: "leak-guard", card: "leakGuard", home: "settings:permissions", warn: "knobs.warn.leak-guard", fields: [
    { name: "sensitivity", kind: "select", def: "standard", options: ["standard", "strict"] },
    { name: "exceptions", kind: "checks", def: [] }] },
];

const kindSlug = (kind) => kind.toLowerCase().replace(/[^a-z0-9]+/g, "-");
/** The sentence after a control, which the control points at. */
function note(id, key, values) {
  const text = keyed("p", key, "subtle", values);
  text.id = `${id}-note`;
  return text;
}
function labelled(id, key, control, noteKey = `knobs.note.${key}`) {
  const label = keyed("label", `knobs.field.${key}`);
  label.htmlFor = id;
  control.id = id;
  control.setAttribute("aria-describedby", `${id}-note`);
  return [label, control, note(id, noteKey)];
}
function option(value, key, values) {
  const node = keyed("option", key, "", values);
  node.value = value;
  return node;
}

/** One control, given the current value; `read()` gives back what would be saved. */
function control(field, value, view) {
  const id = `knobs-${field.name}`;
  if (field.kind === "switch") {
    const control = dropdown({
      id,
      options: [["on", "knobs.option.on"], ["off", "knobs.option.off"]],
      value: value ? "on" : "off"
    });
    return { nodes: labelled(id, field.name, control), read: () => control.value === "on", set: (v) => { control.value = v ? "on" : "off"; } };
  }
  if (field.kind === "number") {
    const input = document.createElement("input");
    Object.assign(input, { type: "number", min: String(field.min), max: String(field.max), step: field.step ?? "1" });
    input.value = value === null || value === undefined ? "" : String(value);
    const launched = field.launched ? view.launched[field.launched] : null;
    if (field.nullable) input.placeholder = launched === null || launched === undefined ? t("knobs.automatic") : t("knobs.automatic-was", { value: formatNumber(launched) });
    const read = () => (input.value === "" ? (field.nullable ? null : field.def) : Number(input.value));
    return { nodes: labelled(id, field.name, input), read, set: (v) => { input.value = v === null ? "" : String(v); } };
  }
  if (field.kind === "select" || field.kind === "connection") return choice(field, id, value, view);
  if (field.kind === "text" || field.kind === "lines") return textBox(field, id, value);
  if (field.kind === "checks") return checks(field, id, value, view);
  return efforts(field, id, value, view);
}

function choice(field, id, value, view) {
  const options = [];
  if (field.kind === "connection") {
    options.push(["", "knobs.option.same-connection"]);
    for (const one of view.connections) options.push([one.id, "", one.name]);
  } else for (const one of field.options) options.push([one, `knobs.option.${one}`]);
  const control = dropdown({ id, options, value: value ?? "" });
  const read = () => (field.kind === "connection" ? control.value || null : control.value);
  return { nodes: labelled(id, field.name, control), read, set: (v) => { control.value = v ?? ""; } };
}

function textBox(field, id, value) {
  const area = document.createElement("textarea");
  area.rows = field.kind === "lines" ? 3 : 5;
  area.value = field.kind === "lines" ? (value ?? []).join("\n") : value ?? "";
  const read = () => (field.kind === "lines" ? area.value.split(/[\s,]+/).filter(Boolean) : area.value);
  const set = (v) => { area.value = field.kind === "lines" ? v.join("\n") : v; };
  return { nodes: labelled(id, field.name, area), read, set };
}

function checks(field, id, value, view) {
  const box = document.createElement("fieldset");
  box.append(keyed("legend", `knobs.field.${field.name}`));
  const ticks = view.leakKinds.map((kind) => {
    const tick = document.createElement("input");
    Object.assign(tick, { type: "checkbox", id: `${id}-${kindSlug(kind)}`, value: kind, checked: value.includes(kind) });
    tick.setAttribute("aria-describedby", `${id}-note`);
    const label = keyed("label", `knobs.kind.${kindSlug(kind)}`);
    label.prepend(tick);
    box.append(label);
    return tick;
  });
  const read = () => ticks.filter((tick) => tick.checked).map((tick) => tick.value);
  const set = (v) => { for (const tick of ticks) tick.checked = v.includes(tick.value); };
  return { nodes: [box, note(id, `knobs.note.${field.name}`)], read, set };
}

function efforts(field, id, value, view) {
  const rows = view.connections.map((one) => {
    const rowId = `${id}-${kindSlug(one.id)}`;
    // phase2/accounts (#22): only the levels this model takes; a saved one it does not take stays shown.
    const takes = one.thinking ? one.thinking.levels : ["low", "medium", "high"];
    const levels = ["low", "medium", "high"].filter((level) => takes.includes(level) || value[one.id] === level);
    const options = [["", "knobs.option.effort-default"], ...levels.map((level) => [level, `knobs.option.effort-${level}`])];
    const control = dropdown({ id: rowId, options, value: value[one.id] ?? "" });
    control.setAttribute("aria-describedby", `${id}-note`);
    const label = Object.assign(document.createElement("label"), { textContent: one.name });
    label.htmlFor = rowId;
    return { one, control, nodes: [label, control] };
  });
  const read = () => Object.fromEntries(rows.filter((row) => row.control.value).map((row) => [row.one.id, row.control.value]));
  const set = (v) => { for (const row of rows) row.control.value = v[row.one.id] ?? ""; };
  return { nodes: [keyed("h4", `knobs.field.${field.name}`, "settings-card-subtitle"), ...rows.flatMap((row) => row.nodes), note(id, `knobs.note.${field.name}`)], read, set };
}

const valueOf = (view, spec, field) => (field.outside ? view[field.name] : view.values[spec.card][field.name]);

function actions(spec, controls, status) {
  const row = document.createElement("div");
  row.className = "identity-actions";
  const send = async (values, done) => {
    const version = beginWrite(spec.id);
    const outside = spec.fields.filter((field) => field.outside);
    const inside = Object.fromEntries(Object.entries(values).filter(([name]) => !outside.some((field) => field.name === name)));
    const extra = Object.fromEntries(outside.map((field) => [field.name, values[field.name]]));
    try {
      const view = await api({ card: spec.card, values: inside, ...extra });
      if (!writeIsCurrent(spec.id, version)) return;
      shown = { ...shown, view }; clearSavedControlDrafts(`#knobs-${spec.id}-card`, controls, values);
      status.textContent = t(done); status.dataset.t = done;
    } catch (error) {
      if (!writeIsCurrent(spec.id, version)) return;
      status.textContent = error.message; delete status.dataset.t;
    } finally {
      finishWrite();
    }
  };
  const save = keyed("button", "knobs.action.save");
  save.type = "button";
  const saveNow = () => send(visibleControlValues(controls), "knobs.saved");
  save.addEventListener("click", saveNow);
  const reset = keyed("button", "knobs.action.reset", "quiet-button");
  reset.type = "button";
  reset.addEventListener("click", () => {
    for (const [field, c] of controls) c.set(field.def);
    void send(Object.fromEntries(spec.fields.map((field) => [field.name, field.def])), "knobs.reset-done");
  });
  row.append(...(spec.asYouGo ? [] : [save]), reset);
  return { row, saveNow };
}

function buildCard(spec, view) {
  const card = document.createElement("section");
  card.className = "card";
  card.id = `knobs-${spec.id}-card`;
  card.dataset.home = spec.home;
  const settings = spec.home.startsWith("settings:");
  card.append(keyed(settings ? "h3" : "h2", `knobs.${spec.id}.title`, settings ? "settings-card-title" : ""),
    keyed("p", `knobs.${spec.id}.lead`, "subtle"));
  if (spec.warn) card.append(keyed("p", spec.warn, "field-note knobs-warning"));
  const controls = spec.fields.map((field) => [field, control(field, valueOf(view, spec, field), view)]);
  for (const [, c] of controls) card.append(...c.nodes);
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  const { row, saveNow } = actions(spec, controls, status);
  card.append(row, status);
  /* DG-025: no Save button: a choice saves when picked, a box when you leave it. */
  if (spec.asYouGo) card.addEventListener("change", () => void saveNow());
  return card;
}

/* The launch settings file, in plain words, with the four things that can be changed from here. */
const LAUNCH_FIELDS = [
  num("commandTimeoutSeconds", 1, 120, 30, { section: "commands" }),
  num("commandOutputBytes", 256, 8192, 8192, { section: "commands" }),
  { name: "commandsOffline", kind: "switch", def: false, section: "commands" },
  { name: "browserSites", kind: "lines", def: [], section: "browser" },
];
function launchFacts(file) {
  if (file.ownerOnly) return [keyed("p", "knobs.launch.owner-only", "subtle")];
  if (!file.path) return [keyed("p", "knobs.launch.none", "subtle")];
  if (file.problem) return [keyed("p", "knobs.launch.problem", "subtle", { problem: file.problem })];
  const facts = file.facts;
  const lines = [
    keyed("p", "knobs.launch.where", "subtle", { path: file.path }),
    keyed("p", "knobs.launch.counts", "subtle", { servers: formatNumber(facts.servers), hooks: formatNumber(facts.hooks),
      chats: facts.chatApps.join(", ") || "—", programs: facts.programs.join(", ") || "—" }),
  ];
  if (facts.keyLikeValues.length) lines.push(keyed("p", "knobs.launch.keys", "field-note", { where: facts.keyLikeValues.join(", ") }));
  for (const line of lines) line.style.overflowWrap = "anywhere";
  return lines;
}
function launchControls(file) {
  const editable = file.editable;
  if (!editable) return [];
  return LAUNCH_FIELDS.filter((field) => (field.section === "commands" ? editable.commands : editable.browserSites))
    .map((field) => {
      const value = field.section === "commands" ? editable.commands[field.name] : editable.browserSites;
      const c = control({ ...field, name: `launch-${field.name}` }, value, { launched: {}, connections: [], leakKinds: [] });
      return [{ ...field, controlName: `launch-${field.name}` }, c];
    });
}
function launchCard(file) {
  const card = document.createElement("section");
  card.className = "card";
  card.id = "knobs-launch-file-card";
  card.dataset.home = "settings:computer";
  card.append(keyed("h3", "knobs.launch-file.title", "settings-card-title"), keyed("p", "knobs.launch-file.lead", "subtle"), ...launchFacts(file));
  const controls = launchControls(file);
  if (!controls.length) return card;
  card.append(keyed("p", "knobs.warn.launch-file", "field-note knobs-warning"));
  for (const [, c] of controls) card.append(...c.nodes);
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  const save = keyed("button", "knobs.action.save-for-next-start");
  save.type = "button";
  save.addEventListener("click", async () => {
    const card = "launch-file";
    const version = beginWrite(card);
    const values = visibleControlValues(controls);
    try {
      await api(values, "knobs/launch-file");
      if (!writeIsCurrent(card, version)) return;
      clearSavedControlDrafts("#knobs-launch-file-card", controls, values);
      status.textContent = t("knobs.launch.saved"); status.dataset.t = "knobs.launch.saved";
    } catch (error) {
      if (!writeIsCurrent(card, version)) return;
      status.textContent = error.message; delete status.dataset.t;
    } finally {
      finishWrite();
    }
  });
  card.append(save, status);
  return card;
}

function place(card) {
  const existing = $(card.id);
  if (existing) existing.replaceWith(card); else document.body.append(card);
}
const knobControlSelector = 'input[id^="knobs-"], select[id^="knobs-"], textarea[id^="knobs-"]';
const controlNodes = (nodes) => nodes.flatMap((node) => node.matches?.(knobControlSelector)
  ? [node] : [...(node.querySelectorAll?.(knobControlSelector) ?? [])]);
function visibleControlValues(controls) {
  return Object.fromEntries(controls.map(([field, control]) => {
    for (const submitted of controlNodes(control.nodes)) {
      const visible = $(submitted.id);
      if (!visible || visible === submitted) continue;
      submitted.value = visible.value;
      if (submitted.type === "checkbox") submitted.checked = visible.checked;
    }
    return [field.name, control.read()];
  }));
}
const sameControlValue = (left, right) => left?.value === right?.value
  && (left?.type !== "checkbox" || left.checked === right.checked);
function clearSavedControlDrafts(card, controls, values) {
  for (const [field, control] of controls) {
    if (JSON.stringify(control.read()) !== JSON.stringify(values[field.name])) continue;
    const prefix = `knobs-${field.controlName ?? field.name}`;
    const submitted = controlNodes(control.nodes).filter((node) => node.id === prefix || node.id.startsWith(prefix + "-"));
    const live = [...document.querySelectorAll(`${card} ${knobControlSelector}`)]
      .filter((node) => node.id === prefix || node.id.startsWith(prefix + "-"));
    if (live.length !== submitted.length || live.some((node) => !sameControlValue(node, submitted.find((old) => old.id === node.id)))) continue;
    for (const node of live) delete node.dataset.knobDirty;
  }
}
function controlDrafts() {
  const active = document.activeElement;
  return {
    active: active?.id ?? "",
    selection: active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null,
    values: [...document.querySelectorAll(knobControlSelector)]
      .filter((node) => node === active || node.dataset.knobDirty === "true")
      .map((node) => [node.id, { value: node.value, checked: node.type === "checkbox" ? node.checked : null,
        dirty: node.dataset.knobDirty === "true" }]),
  };
}
function restoreControlDrafts(drafts) {
  for (const [id, saved] of drafts.values) {
    const node = $(id);
    if (!node) continue;
    node.value = saved.value;
    if (saved.checked !== null) node.checked = saved.checked;
    if (saved.dirty) node.dataset.knobDirty = "true"; else delete node.dataset.knobDirty;
  }
  const active = $(drafts.active);
  if (!active) return;
  active.focus({ preventScroll: true });
  if (drafts.selection?.every(Number.isInteger) && typeof active.setSelectionRange === "function")
    active.setSelectionRange(...drafts.selection);
}
function draw(preserveDrafts = false) {
  if (!shown) return;
  const drafts = preserveDrafts ? controlDrafts() : null;
  for (const spec of CARDS) place(buildCard(spec, shown.view));
  if (shown.file) place(launchCard(shown.file));
  if (drafts) restoreControlDrafts(drafts);
}
const allCardsAreDrawn = () => CARDS.every((spec) => $(`knobs-${spec.id}-card`)) && $("knobs-launch-file-card");
async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  const version = stateVersion;
  try {
    const [view, file] = await Promise.all([api(), api(undefined, "knobs/launch-file")]);
    if (version !== stateVersion || writesInFlight) return;
    const next = { view, file };
    if (shown && allCardsAreDrawn() && JSON.stringify(next) === JSON.stringify(shown)) return;
    shown = next;
    draw(true);
  } catch { /* signed out or offline: the next look tries again */ }
}
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

if (typeof document !== "undefined") {
  const markDirty = (event) => {
    if (!event.target?.matches?.(knobControlSelector)) return;
    event.target.dataset.knobDirty = "true";
    stateVersion += 1;
  };
  document.addEventListener("input", markDirty, true);
  document.addEventListener("change", markDirty, true);
  void refresh();
  document.addEventListener("branch-language", () => draw(true));
  const signedIn = $("workspace");
  if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
  window.branchKnobs = { refresh };
}
