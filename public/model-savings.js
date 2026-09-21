/**
 * R17-E: models, cheaper and smarter. Seven cards: the planning connection, choosing by difficulty,
 * counting what the service says, keeping the cache warm, OpenRouter's company choice, mixtures of
 * models, and the per-round chart switch. Values live on the server (src/model-savings/); this file
 * only shows them and sends changes back.
 *
 * Each card says where it lives with `data-home` (docs/places.md), follows the card anatomy in
 * docs/design.md, and every control is described by the sentence straight after it, linked with
 * aria-describedby. Every word is behind a key in public/locales.
 */
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
let view = null;

async function api(body) {
  const response = await fetch("/api/model-savings", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("savings.failed"));
  return data;
}

function keyed(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function note(id, key) {
  const text = keyed("p", key, "subtle field-note");
  text.id = `${id}-note`;
  return text;
}
function labelled(id, key, control) {
  const label = keyed("label", `savings.field.${key}`);
  label.htmlFor = id;
  control.id = id;
  control.setAttribute("aria-describedby", `${id}-note`);
  return [label, control, note(id, `savings.note.${key}`)];
}

/* Fields: switch (off/on), three (off/on/when-needed), connection, select, number, lines. */
const CARDS = [
  { id: "phases", home: "settings:models:defaults", fields: [{ name: "planModel", kind: "connection" },
    { name: "sideTier", kind: "select", options: ["same", "flex"], optionKey: "tier" }] },
  { id: "difficulty", home: "settings:models:defaults", warn: "savings.warn.difficulty", fields: [
    { name: "mode", kind: "three", key: "difficultyMode" },
    { name: "classifierModel", kind: "connection" }, { name: "easyModel", kind: "connection", none: "savings.option.pick" },
    { name: "hardModel", kind: "connection", none: "savings.option.pick" }] },
  { id: "reportedTokens", slug: "reported-tokens", home: "settings:models:defaults", fields: [{ name: "mode", kind: "switch", key: "reportedMode" }] },
  { id: "keepAlive", slug: "keep-alive", home: "settings:models:defaults", warn: "savings.warn.keep-alive", fields: [
    { name: "mode", kind: "switch", key: "keepAliveMode" },
    { name: "everyMinutes", kind: "number", min: 1, max: 55 }, { name: "maxPings", kind: "number", min: 1, max: 12 },
    { name: "spendCapDollars", kind: "number", min: 0.001, max: 5, step: "0.001" }] },
  { id: "openrouter", home: "settings:models:connection", fields: [
    { name: "mode", kind: "switch", key: "openrouterMode" },
    { name: "sort", kind: "select", options: ["", "price", "throughput", "latency"], optionKey: "sort" },
    { name: "order", kind: "lines" }, { name: "only", kind: "lines" }, { name: "ignore", kind: "lines" },
    { name: "allowFallbacks", kind: "bool" },
    { name: "dataCollection", kind: "select", options: ["allow", "deny"], optionKey: "data" }] },
  { id: "roundChart", slug: "round-chart", home: "settings:appearance", fields: [{ name: "mode", kind: "switch", key: "roundChartMode" }] },
];
const slugOf = (spec) => spec.slug ?? spec.id;

function select(id, key, values, current) {
  const box = dropdown({ id, options: values, value: current ?? "" });
  return { nodes: labelled(id, key, box), box };
}
function connectionChoices(none = "savings.option.same-connection") {
  return [["", none], ...view.connections.map((one) => [one.id, "", one.name])];
}
function connectionSelect(id, key, current, none) {
  const box = dropdown({ id, options: connectionChoices(none), value: current ?? "" });
  return { nodes: labelled(id, key, box), read: () => box.value || null };
}

/** One control for one field; `read()` gives back what would be saved. */
function control(spec, field, value) {
  const id = `savings-${slugOf(spec)}-${field.name}`;
  const key = field.key ?? field.name;
  if (field.kind === "connection") return connectionSelect(id, key, value, field.none);
  if (field.kind === "switch" || field.kind === "three" || field.kind === "bool") {
    const modes = field.kind === "three" ? ["off", "on", "when-needed"] : ["off", "on"];
    const current = field.kind === "bool" ? (value ? "on" : "off") : value;
    const { nodes, box } = select(id, key, modes.map((mode) => [mode, `savings.option.${mode}`]), current);
    return { nodes, read: () => (field.kind === "bool" ? box.value === "on" : box.value) };
  }
  if (field.kind === "select") {
    const { nodes, box } = select(id, key, field.options.map((one) => [one, `savings.option.${field.optionKey}-${one || "default"}`]), value ?? "");
    return { nodes, read: () => (field.name === "sort" ? box.value || null : box.value) };
  }
  if (field.kind === "number") {
    const input = document.createElement("input");
    Object.assign(input, { type: "number", min: String(field.min), max: String(field.max), step: field.step ?? "1", value: String(value) });
    return { nodes: labelled(id, key, input), read: () => Number(input.value) };
  }
  const area = document.createElement("textarea");
  area.rows = 2;
  area.value = (value ?? []).join("\n");
  return { nodes: labelled(id, key, area), read: () => area.value.split(/[\s,]+/).filter(Boolean) };
}

function statusLine() {
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  return status;
}
/** Sends one change; the cards are drawn again, so the result is written into the new card's status line. */
async function send(body, status, done) {
  const cardId = status.closest(".card")?.id;
  try {
    view = await api(body);
    draw();
    const fresh = (cardId && $(cardId)?.querySelector("[role=status]")) || status;
    fresh.textContent = t(done);
    fresh.dataset.t = done;
  } catch (error) { status.textContent = error.message; delete status.dataset.t; }
}
function shell(id, home, warn) {
  const card = document.createElement("section");
  card.className = "card";
  card.id = `savings-${id}-card`;
  card.dataset.home = home;
  card.append(keyed("h2", `savings.${id}.title`), keyed("p", `savings.${id}.lead`, "subtle"));
  if (warn) card.append(keyed("p", warn, "field-note"));
  return card;
}
function buttons(onSave, onReset, saveKey = "savings.action.save") {
  const row = document.createElement("div");
  row.className = "identity-actions";
  const save = keyed("button", saveKey);
  save.type = "button";
  save.addEventListener("click", onSave);
  const reset = keyed("button", "savings.action.reset", "quiet-button");
  reset.type = "button";
  reset.addEventListener("click", onReset);
  row.append(save, reset);
  return row;
}

function buildCard(spec) {
  const card = shell(slugOf(spec), spec.home, spec.warn);
  const values = view.values[spec.id];
  const controls = spec.fields.map((field) => [field, control(spec, field, values[field.name])]);
  for (const [, c] of controls) card.append(...c.nodes);
  const status = statusLine();
  card.append(buttons(
    () => send({ card: spec.id, values: Object.fromEntries(controls.map(([field, c]) => [field.name, c.read()])) }, status, "savings.saved"),
    () => send({ card: spec.id, reset: true }, status, "savings.reset-done"),
  ), status);
  return card;
}

/* Mixtures: the ones saved, each with Remove, then a short form to add one. */
function mixtureRow(mixture, status) {
  const row = document.createElement("div");
  row.className = "identity-actions";
  const live = view.liveMixtures.includes(`mixture-${mixture.id}`);
  const names = (ids) => ids.map((id) => view.connections.find((one) => one.id === id)?.name ?? id).join(", ");
  row.append(keyed("span", live ? "savings.mixture.live" : "savings.mixture.waiting", "", {
    name: mixture.name, references: names(mixture.references), aggregator: names([mixture.aggregator]) }));
  const remove = keyed("button", "savings.action.remove", "quiet-button");
  remove.type = "button";
  remove.addEventListener("click", () => send({ card: "mixtures",
    values: { mixtures: view.values.mixtures.mixtures.filter((one) => one.id !== mixture.id) } }, status, "savings.saved"));
  row.append(remove);
  return row;
}
function referenceTicks(id) {
  const box = document.createElement("fieldset");
  box.append(keyed("legend", "savings.field.references"));
  const ticks = view.connections.map((one) => {
    const tick = Object.assign(document.createElement("input"), { type: "checkbox", value: one.id, id: `${id}-${one.id.replace(/[^a-z0-9]+/gi, "-")}` });
    tick.setAttribute("aria-describedby", `${id}-note`);
    const label = document.createElement("label");
    label.append(tick, document.createTextNode(` ${one.name}`));
    box.append(label);
    return tick;
  });
  return { nodes: [box, note(id, "savings.note.references")], read: () => ticks.filter((tick) => tick.checked).map((tick) => tick.value) };
}
function mixturesCard() {
  const card = shell("mixtures", "settings:models:second", "savings.warn.mixtures");
  const status = statusLine();
  const saved = view.values.mixtures.mixtures;
  if (!saved.length) card.append(keyed("p", "savings.mixture.none", "subtle"));
  for (const mixture of saved) card.append(mixtureRow(mixture, status));
  const nameBox = Object.assign(document.createElement("input"), { type: "text", maxLength: 60 });
  const refs = referenceTicks("savings-mixtures-references");
  const writer = connectionSelect("savings-mixtures-aggregator", "aggregator", null, "savings.option.pick");
  const cap = Object.assign(document.createElement("input"), { type: "number", min: "64", max: "4096", step: "1", value: "1024" });
  card.append(keyed("h3", "savings.mixture.add"), ...labelled("savings-mixtures-name", "mixtureName", nameBox),
    ...refs.nodes, ...writer.nodes, ...labelled("savings-mixtures-cap", "referenceMaxTokens", cap));
  const add = () => {
    const name = nameBox.value.trim();
    const id = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mixture";
    const next = { id, name, references: refs.read(), aggregator: writer.read(), referenceMaxTokens: Number(cap.value) };
    return send({ card: "mixtures", values: { mixtures: [...saved.filter((one) => one.id !== id), next] } }, status, "savings.saved");
  };
  card.append(buttons(add, () => send({ card: "mixtures", reset: true }, status, "savings.reset-done"), "savings.action.add"), status);
  return card;
}

function place(card) {
  const existing = $(card.id);
  if (existing) existing.replaceWith(card); else document.body.append(card);
}
function draw() {
  if (!view) return;
  for (const spec of CARDS) place(buildCard(spec));
  place(mixturesCard());
  document.dispatchEvent(new CustomEvent("branch-model-savings", { detail: view }));
}
async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { view = await api(); draw(); } catch { /* signed out or offline: the next look tries again */ }
}
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

if (typeof document !== "undefined") {
  void refresh();
  document.addEventListener("branch-language", draw);
  const signedIn = $("workspace");
  if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
  window.branchModelSavings = { refresh };
}
