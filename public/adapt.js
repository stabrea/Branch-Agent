/**
 * mac7/adapt (Settings → Models → On this computer): getting what a stopped task is missing.
 *
 * The card shows the three-way switch, what is stopped now, and — for the newest stop — what is
 * missing, what would fix it and what that costs. Nothing is fetched or changed until the owner
 * presses the button that carries that exact offer's own line, the way the one-button install does.
 * Every word goes through a key, so the card reads the same in French; it lays out in one column,
 * so it reads on a 400-pixel-wide window.
 */
import { t } from "/i18n.js";
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const keyed = (tag, key, className, values) => {
  const node = el(tag, t(key, values), className);
  if (values) node.dataset.tKey = key; else node.dataset.t = key;
  return node;
};
const button = (key, onClick, className = "quiet-button") => {
  const node = keyed("button", key, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};

/** The offer on the screen now. A yes may only ever carry this one's own line. */
let offer = null;

const positions = [["off", "field.switch-off"], ["when-needed", "field.switch-when-needed"], ["on", "field.switch-on"]];
function switchRow(mode) {
  const label = keyed("label", "field.adapt-switch");
  label.htmlFor = "adapt-mode";
  const select = el("select");
  select.id = "adapt-mode";
  for (const [value, key] of positions) {
    const option = keyed("option", key);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    offer = null;
    await api("adapt/switch", { mode: select.value }).catch((error) => toast(error.message));
    await drawAdapt();
  });
  return [label, select, keyed("p", "adapt.switch-note", "field-note")];
}

/** One stop: what the task was doing, and the step it stopped on. */
function stopRow(stop) {
  const row = el("div", undefined, "item");
  row.append(el("h3", stop.what));
  row.append(keyed("p", "adapt.stopped-at", "local-detail", { step: stop.nextStep, said: stop.blocker.said }));
  if (stop.done.length) row.append(keyed("p", "adapt.already-done", "local-detail", { count: String(stop.done.length) }));
  return row;
}

/** What is missing, what would fix it and what it costs — then the button that agrees to it. */
function offerBlock(view) {
  const nodes = [];
  if (view.refusal) return [keyed("p", "adapt.refused", "local-warning", { why: view.refusal })];
  if (!view.fix) return [keyed("p", "adapt.nothing", "empty-state", { message: view.message })];
  nodes.push(keyed("p", "adapt.missing", "local-detail", { what: view.blocker.what, said: view.blocker.said }));
  nodes.push(keyed("p", "adapt.would", "local-detail", { what: view.fix.what }));
  if (view.fix.instead) {
    nodes.push(keyed("p", "adapt.cannot", "local-warning", { instead: view.fix.instead }));
    return nodes;
  }
  if (view.fix.from) nodes.push(keyed("p", "adapt.cost", "local-detail", { from: view.fix.from, size: view.fix.size }));
  if (view.fix.needsOwnerKey) nodes.push(keyed("p", "adapt.needs-key", "local-warning"));
  const go = button("action.adapt-go", () => void agree(view.fix.fingerprint));
  go.dataset.tTitle = "action.adapt-go-title";
  go.title = t(go.dataset.tTitle);
  nodes.push(go);
  return nodes;
}

async function agree(fingerprint) {
  const answer = await api("adapt/go", { agreed: fingerprint }).catch((error) => { toast(error.message); return null; });
  if (!answer) return;
  toast(answer.message);
  // The offer changed between reading it and pressing: show the new one rather than get anything.
  offer = null;
  await drawAdapt();
}

export async function drawAdapt() {
  const host = $("adapt-body");
  if (!host) return;
  let view;
  try { view = await api("adapt", undefined, "GET"); } catch (error) {
    host.replaceChildren(el("p", error.message, "subtle"));
    return;
  }
  const nodes = [...switchRow(view.mode)];
  if (view.mode === "off") {
    host.replaceChildren(...nodes, keyed("p", "adapt.off", "subtle"));
    return;
  }
  const stops = view.stops ?? [];
  for (const stop of stops) nodes.push(stopRow(stop));
  if (!stops.length) nodes.push(keyed("p", "adapt.none-stopped", "empty-state"));
  const show = button("action.adapt-look", async () => {
    offer = await api("adapt/plan", {}).catch((error) => { toast(error.message); return null; });
    await drawAdapt();
  });
  show.dataset.tTitle = "action.adapt-look-title";
  show.title = t(show.dataset.tTitle);
  nodes.push(show);
  if (offer) nodes.push(...offerBlock(offer));
  host.replaceChildren(...nodes);
}

/* Drawn when the card comes into view and again on a language change, as the models card is. */
if ($("adapt-card")) {
  const signedIn = () => { try { return Boolean(sessionStorage.getItem("branch-token")); } catch { return false; } };
  if (signedIn()) void drawAdapt();
  document.addEventListener("branch-language", () => void drawAdapt());
  new IntersectionObserver((entries) => { if (signedIn() && entries.some((entry) => entry.isIntersecting)) void drawAdapt(); }).observe($("adapt-card"));
}
