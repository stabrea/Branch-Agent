/**
 * Wave mac5: one-click models on this computer (Settings → Models → On this computer).
 *
 * Draws inside the existing "Models on this computer" card: the three-way switch, which program
 * runs the models (with the official install page when it is missing), what fits this computer,
 * searching the program's own library, setups with their progress, what is loaded, and what is
 * downloaded with the space it takes. Every word goes through a key; colours come from tokens.
 */
import { t, language, formatNumber } from "/i18n.js";
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/*
 * A fixed phrase carries `data-t`, so the window's language pass can rewrite it. A phrase with
 * {values} carries `data-t-key` instead: that pass knows nothing of the values and would print the
 * raw {placeholders}, so this block redraws itself on a language change.
 */
const keyed = (tag, key, className, values) => {
  const node = el(tag, t(key, values), className);
  if (values) node.dataset.tKey = key; else node.dataset.t = key;
  return node;
};
const gb = (bytes) => formatNumber(Math.round((Number(bytes) / 1024 ** 3) * 10) / 10);
const button = (key, onClick, className = "quiet-button", values) => {
  const node = keyed("button", key, className, values);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};
const programNames = { ollama: "Ollama", "lm-studio": "LM Studio", "llama-cpp": "llama.cpp", mlx: "MLX" };
let chosenRuntime = null;
let polling = null;

async function act(path, body, doneKey, values) {
  try {
    const result = await api(path, body);
    if (result?.needsRuntime) toast(t("local.oneclick.needs-runtime"));
    else if (doneKey) toast(t(doneKey, values));
    await drawOneClick();
    return result;
  } catch (error) { toast(error.message); return null; }
}

const positions = [["off", "field.switch-off"], ["when-needed", "field.switch-when-needed"], ["on", "field.switch-on"]];
function switchRow(mode) {
  const label = keyed("label", "field.local-models-switch");
  label.htmlFor = "local-models-mode";
  const select = el("select");
  select.id = "local-models-mode";
  for (const [value, key] of positions) {
    const option = keyed("option", key);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  }
  select.addEventListener("change", () => void act("local-models/switch", { mode: select.value }, "local.oneclick.saved"));
  return [label, select, keyed("p", "local.oneclick.switch-note", "field-note")];
}

function runtimeRow(view) {
  const label = keyed("label", "field.local-models-program");
  label.htmlFor = "local-models-runtime";
  const select = el("select");
  select.id = "local-models-runtime";
  const current = view.runtimes.find((one) => one.id === chosenRuntime) ?? view.runtimes.find((one) => one.id === view.chosen);
  for (const runtime of view.runtimes) {
    const option = keyed("option", runtime.installed ? "local.runtime.installed" : "local.runtime.missing", undefined, { name: runtime.name });
    option.value = runtime.id;
    option.selected = runtime.id === current.id;
    select.append(option);
  }
  select.addEventListener("change", () => { chosenRuntime = select.value; void drawOneClick(); });
  const nodes = [label, select];
  if (!current.installed) {
    const note = keyed("p", "local.runtime.install-note", "field-note", { name: current.name });
    const link = keyed("a", "local.runtime.install-link", undefined, { name: current.name });
    link.href = current.installPage;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    note.append(" ", link);
    nodes.push(note);
  } else if (current.startedByBranch || current.id === "lm-studio") {
    nodes.push(button("action.local-stop-program", () => void act("local-models/runtime/stop", { runtime: current.id }, "local.runtime.stopped", { name: current.name })));
  }
  return { nodes, current };
}

function roomLine(room) {
  const values = { free: gb(room.freeMemoryBytes), total: gb(room.totalMemoryBytes) };
  const line = keyed("p", "local.room.free", "subtle", values);
  if (room.graphicsLimitBytes) line.append(" ", t("local.room.graphics-limit", { limit: gb(room.graphicsLimitBytes) }));
  return line;
}

function variantRow(offer, variant, runtime) {
  const row = el("div", undefined, "local-variant");
  row.append(el("strong", variant.quant));
  row.append(keyed("span", `local.size.${variant.label}`, "meta"));
  const badge = keyed("span", `local.fit.${variant.fit}`, "local-fit");
  badge.dataset.fit = variant.fit;
  row.append(badge);
  row.append(keyed("span", "local.fit.detail", "local-detail", {
    download: gb(variant.downloadBytes), need: gb(variant.needsBytes), words: formatNumber(variant.context),
  }));
  const setUp = button("action.local-set-up", () => void act("local-models/setup",
    { runtime, model: offer.id, quant: variant.quant, force: variant.fit === "no" }, "local.oneclick.started", { name: offer.name }));
  if (variant.fit === "no") {
    setUp.dataset.t = "action.local-set-up-anyway";
    setUp.textContent = t(setUp.dataset.t);
  }
  row.append(setUp);
  return row;
}

function offerItem(offer, runtime) {
  const node = el("div", undefined, "item");
  node.append(el("h3", `${offer.name} · ${offer.params}`));
  node.append(el("p", language() === "fr" ? offer.summary.fr : offer.summary.en));
  if (!offer.tools) node.append(keyed("p", "local.offer.no-tools", "local-warning"));
  if (offer.vision) node.append(keyed("p", "local.offer.pictures", "local-detail"));
  for (const variant of offer.variants) node.append(variantRow(offer, variant, runtime));
  return node;
}

function searchBlock(runtime) {
  const wrap = el("div", undefined, "local-search");
  const input = el("input");
  input.id = "local-models-search";
  input.maxLength = 80;
  input.dataset.tLabel = "field.local-models-search";
  input.setAttribute("aria-label", t("field.local-models-search"));
  input.dataset.tPlaceholder = runtime === "ollama" ? "local.search.placeholder-ollama" : "local.search.placeholder";
  input.placeholder = t(input.dataset.tPlaceholder);
  const results = el("div", undefined, "card-list");
  const go = button("action.local-search", async () => {
    const found = await api("local-models/search", { runtime, query: input.value.trim() }).catch((error) => { toast(error.message); return null; });
    if (found) results.replaceChildren(...searchResults(found, runtime));
  });
  const row = el("div", undefined, "input-row");
  row.append(input, go);
  wrap.append(row, keyed("p", runtime === "ollama" ? "local.search.ollama-note" : "local.search.hf-note", "field-note"), results);
  return wrap;
}
function searchResults(found, runtime) {
  if (!found.hits.length) return [keyed("p", "local.search.none", "empty-state")];
  return found.hits.map((hit) => {
    const node = el("div", undefined, "item");
    node.append(el("h3", hit.name));
    node.append(keyed("p", hit.bytes ? "local.search.size" : "local.search.unknown-tools", "local-detail", { size: gb(hit.bytes ?? 0) }));
    if (runtime === "llama-cpp") node.append(keyed("p", "local.search.list-only", "local-detail"));
    else node.append(button("action.local-set-up", () => void act("local-models/setup", { runtime, name: hit.name }, "local.oneclick.started", { name: hit.name })));
    return node;
  });
}

/* ---------------------------------------------- mac7/one-click (issue #107): the one button */

let buttonPlan = null;

/** The switch that says whether Branch may install a program that runs models. Ships off. */
function installSwitch(mode) {
  const label = keyed("label", "field.local-install-switch");
  label.htmlFor = "local-install-mode";
  const select = el("select");
  select.id = "local-install-mode";
  select.dataset.tTitle = "field.local-install-switch-title";
  select.title = t(select.dataset.tTitle);
  for (const [value, key] of positions) {
    const option = keyed("option", key);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  }
  select.addEventListener("change", () => {
    buttonPlan = null;
    void act("local-models/install/switch", { mode: select.value }, "local.oneclick.saved");
  });
  return [label, select, keyed("p", "local.install.switch-note", "field-note")];
}

/** What would be installed, in plain words, with the exact commands Branch would run. */
function planDetail(plan) {
  const nodes = [keyed("p", "local.install.what", "local-detail", { name: plan.name, publisher: plan.publisher }),
    keyed("p", "local.install.from", "local-detail", { source: plan.source, size: gb(plan.approxBytes) }),
    keyed("p", "local.install.checked", "local-detail", { how: plan.verify })];
  for (const step of plan.steps) {
    const line = el("div", undefined, "local-detail");
    line.append(el("code", step.command.join(" ")));
    nodes.push(line);
  }
  if (plan.after) nodes.push(keyed("p", "local.install.after", "local-detail", { after: plan.after }));
  return nodes;
}

/** The three sizes, with what each one means for this computer. */
function choiceRow(choice, onPick, recommended) {
  const row = el("div", undefined, "local-variant");
  row.append(keyed("span", `local.size.${choice.size === "medium" ? "balanced" : choice.size === "large" ? "full" : "small"}`, "meta"));
  row.append(el("strong", `${choice.name} ${choice.quant}`));
  const badge = keyed("span", `local.fit.${choice.fit}`, "local-fit");
  badge.dataset.fit = choice.fit;
  row.append(badge);
  row.append(keyed("span", "local.install.guidance", "local-detail", { guidance: choice.guidance, size: gb(choice.downloadBytes) }));
  const pick = button(recommended ? "action.local-install-go-suggested" : "action.local-install-go", () => onPick(choice.size));
  pick.dataset.tTitle = "action.local-install-go-title";
  pick.title = t(pick.dataset.tTitle);
  row.append(pick);
  return row;
}

async function pressButton(body) {
  const answer = await api("local-models/one-button", body).catch((error) => { toast(error.message); return null; });
  if (!answer) return;
  toast(answer.message);
  // The plan changed between reading it and pressing: show the new one rather than install anything.
  buttonPlan = answer.needsAgreement ? await api("local-models/one-button/plan", {}).catch(() => null) : null;
  await drawOneClick();
}

/** The whole "do it all for me" block: the switch, the button, and what it would do. */
function oneButtonBlock(view) {
  const nodes = [keyed("h3", "local.section.one-button"), ...installSwitch(view.installMode)];
  const show = button("action.local-one-button", async () => {
    const answer = await api("local-models/one-button/plan", {}).catch((error) => { toast(error.message); return null; });
    if (!answer) return;
    buttonPlan = answer;
    await drawOneClick();
  });
  show.dataset.tTitle = "action.local-one-button-title";
  show.title = t(show.dataset.tTitle);
  nodes.push(show);
  const shown = buttonPlan;
  if (!shown) return nodes;
  const plan = shown.install ?? null;
  if (shown.refusal) nodes.push(keyed("p", "local.install.refused", "local-warning", { why: shown.refusal }));
  else if (plan) nodes.push(...planDetail(plan));
  else nodes.push(keyed("p", "local.install.already", "local-detail", { name: shown.name ?? "" }));
  const choices = shown.choices ?? [];
  const onPick = (size) => void pressButton({ size, ...(plan ? { agreedPlan: plan.fingerprint } : {}) });
  for (const choice of choices) nodes.push(choiceRow(choice, onPick, choice.size === shown.recommended));
  if (!choices.length) nodes.push(keyed("p", "local.offers.empty", "empty-state"));
  return nodes;
}

function setupItem(job) {
  const node = el("div", undefined, "item");
  node.append(el("h3", job.label));
  const bar = el("progress");
  bar.max = 100;
  bar.value = job.percent;
  node.append(bar);
  const stage = keyed("p", `local.stage.${job.stage}`, undefined, { percent: job.percent, done: gb(job.completed), total: gb(job.total) });
  if (job.stage === "failed") stage.append(" ", job.message);
  node.append(stage);
  if (job.stage === "done") node.append(keyed("p", "local.stage.runs-here", "local-here"));
  if (!job.finishedAt) node.append(button("action.local-stop-setup", () => void act("local-models/setup/stop", { id: job.id }, "local.oneclick.stopping")));
  return node;
}

function loadedItem(model) {
  const node = el("div", undefined, "item");
  node.append(el("h3", model.name));
  node.append(keyed("p", "local.loaded.detail", "local-detail", { program: programNames[model.runtime], size: gb(model.sizeBytes), words: model.contextLength ? formatNumber(model.contextLength) : "?" }));
  node.append(button("action.local-unload", () => void act("local-models/unload", { runtime: model.runtime, id: model.instanceId }, "local.loaded.unloaded", { name: model.name })));
  return node;
}

function diskItem(model) {
  const node = el("div", undefined, "item");
  node.append(el("h3", model.name));
  node.append(keyed("p", model.connectionId ? "local.disk.connected" : "local.disk.detail", "local-detail", { size: gb(model.sizeBytes), program: programNames[model.runtime] }));
  node.append(button("action.local-remove", () => {
    if (!confirm(t("local.disk.confirm", { name: model.name, size: gb(model.sizeBytes) }))) return;
    void act("local-models/delete", { runtime: model.runtime, id: model.name }, "local.disk.removed", { name: model.name, size: gb(model.sizeBytes) });
  }, "quiet-button", { size: gb(model.sizeBytes) }));
  return node;
}

function section(key, items, emptyKey) {
  return [keyed("h3", key), ...(items.length ? items : [keyed("p", emptyKey, "empty-state")])];
}

/* Draws can overlap (coming into view, the switch saving, a language change). Only the newest one
   is drawn, so a view read before the switch moved never puts the old position back. */
let drawing = 0;

/** Draws the whole one-click block from one request. */
export async function drawOneClick() {
  const host = $("local-oneclick");
  if (!host) return;
  const turn = ++drawing;
  let view;
  try { view = await api("local-models"); } catch (error) {
    if (turn === drawing) host.replaceChildren(el("p", error.message, "subtle"));
    return;
  }
  if (turn !== drawing) return;
  const nodes = [...switchRow(view.mode)];
  if (view.mode === "off" || !view.oneClick) {
    host.replaceChildren(...nodes, keyed("p", "local.oneclick.off", "subtle"));
    return;
  }
  const one = view.oneClick;
  const { nodes: programNodes, current } = runtimeRow(one);
  nodes.push(...programNodes, roomLine(one.room), ...oneButtonBlock({ ...one, installMode: view.installMode }));
  const offers = chosenRuntime && chosenRuntime !== one.chosen
    ? (await api("local-models/offers", { runtime: current.id }).catch(() => ({ offers: [] }))).offers : one.offers;
  nodes.push(...section("local.section.setups", one.setups.map(setupItem), "local.setups.empty"));
  if (current.installed) nodes.push(...section("local.section.offers", offers.map((offer) => offerItem(offer, current.id)), "local.offers.empty"), searchBlock(current.id));
  nodes.push(...section("local.section.loaded", one.loaded.map(loadedItem), "local.loaded.empty"));
  nodes.push(...section("local.section.disk", one.onDisk.map(diskItem), "local.disk.empty"));
  if (turn !== drawing) return;
  host.replaceChildren(...nodes);
  const busy = one.setups.some((job) => !job.finishedAt);
  if (busy && !polling) polling = setInterval(() => void drawOneClick(), 2000);
  if (!busy && polling) { clearInterval(polling); polling = null; }
}

if ($("local-oneclick")) {
  const signedIn = () => { try { return Boolean(sessionStorage.getItem("branch-token")); } catch { return false; } };
  if (signedIn()) void drawOneClick();
  document.addEventListener("branch-language", () => void drawOneClick());
  /* The page loads before the owner signs in, so the block is drawn again each time it comes into view. */
  new IntersectionObserver((entries) => { if (signedIn() && entries.some((entry) => entry.isIntersecting)) void drawOneClick(); }).observe($("local-oneclick"));
  /* Settings may already be open when the owner signs in: draw once the workspace is shown. */
  const workspace = $("workspace");
  if (workspace) new MutationObserver(() => { if (!workspace.hidden) void drawOneClick(); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
}
