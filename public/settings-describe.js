/**
 * R17-S01 and R17-S04: Settings that explain themselves.
 *
 * Every control on a Settings page gets one sentence under it saying what it does and what changing
 * it means (`public/settings-descriptions.js`), linked with `aria-describedby`. A control that
 * already names its own description, or has a `.field-note` straight after it, keeps that.
 *
 * Every Settings card also gets a small chip saying how far it reaches: everything, this project
 * only, or this computer only. A card can say so itself with `data-scope="project"`,
 * `"computer"` or `"trunk"`; otherwise the table below decides, and the rest apply to everything.
 *
 * Nothing here saves anything or moves a card. It only adds words.
 */
import { t } from "/i18n.js";
import { descriptions, switchDescription } from "/settings-descriptions.js";

const CARDS = ".lx-page .card";
const CONTROLS = "input:not([type=hidden]), select, textarea";
let made = 0;

/** A key's words, or the English given when the language file does not have them yet. */
const say = (key, english) => { const words = t(key); return words === key ? english : words; };

/** The control's described-by list resolves to words on the page. */
function described(control) {
  const ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  return ids.some((id) => document.getElementById(id)?.textContent.trim());
}

function note(key, english) {
  const node = document.createElement("p");
  node.className = "field-note kit-describe";
  node.id = `kit-describe-${++made}`;
  node.dataset.t = key;
  node.textContent = say(key, english);
  return node;
}

function link(control, node) {
  const ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  if (!ids.includes(node.id)) control.setAttribute("aria-describedby", [...ids, node.id].join(" "));
}

/** Puts one sentence under a control (or under the label it sits in), unless it has one already. */
function attach(control, key, english) {
  if (described(control)) return;
  const label = control.closest("label");
  const anchor = label && label.contains(control) ? label : control;
  const next = anchor.nextElementSibling;
  if (next?.classList.contains("kit-describe") && next.dataset.t === key) return link(control, next);
  const node = note(key, english);
  anchor.after(node);
  link(control, node);
}

/** A row like "#models-fallback input" describes a group: one sentence after the group, shared. */
function attachGroup(selector, key, english) {
  const [group, inner] = selector.split(/ (.*)/s, 2);
  const holder = document.querySelector(group);
  if (!holder?.closest(CARDS)) return;
  const controls = [...holder.querySelectorAll(inner)].filter((control) => !described(control));
  if (!controls.length) return;
  let node = holder.nextElementSibling;
  if (!(node?.classList.contains("kit-describe") && node.dataset.t === key)) {
    node = note(key, english);
    holder.after(node);
  }
  for (const control of controls) link(control, node);
}

const isSwitch = (control) => control.tagName === "SELECT" && control.options.length > 0
  && [...control.options].every((option) => ["off", "on", "when-needed"].includes(option.value));

function describeAll() {
  for (const [selector, key, english] of descriptions) {
    if (selector.includes(" ")) { attachGroup(selector, key, english); continue; }
    const control = document.querySelector(selector);
    if (control?.closest(CARDS)) attach(control, key, english);
  }
  for (const control of document.querySelectorAll(`${CARDS} :is(${CONTROLS})`)) {
    if (described(control)) continue;
    const label = control.closest("label");
    const next = (label && label.contains(control) ? label : control).nextElementSibling;
    if (next?.classList.contains("field-note") && next.textContent.trim()) {
      if (!next.id) next.id = `kit-describe-${++made}`;
      link(control, next);
    } else if (isSwitch(control)) attach(control, ...switchDescription);
  }
}

/* ---------- scope chips ---------- */

const SCOPES = {
  everything: ["settings-kit.scope.everything", "Applies to everything"],
  project: ["settings-kit.scope.project", "Applies to this project only"],
  computer: ["settings-kit.scope.computer", "Applies to this computer only"],
  trunk: ["settings-kit.scope.trunk", "Applies to this Trunk only"],
};
/** Cards that reach less than everything. A card's own `data-scope` wins over this. */
const SCOPE_OF = {
  "projects-form": "project", "context-project": "project", "secrets-form": "project",
  "settings-form": "computer", "deployment-card": "computer", "never-break-card": "computer",
};

function chip(card) {
  const scope = SCOPES[card.dataset.scope] ? card.dataset.scope : (SCOPE_OF[card.id] ?? "everything");
  const [key, english] = SCOPES[scope];
  let row = card.querySelector(":scope > .kit-scope");
  if (row?.dataset.scope === scope) return;
  if (!row) {
    row = document.createElement("p");
    row.className = "kit-scope";
    const heading = card.querySelector(":scope > h2");
    const purpose = heading?.nextElementSibling?.tagName === "P" ? heading.nextElementSibling : heading;
    if (purpose) purpose.after(row); else card.prepend(row);
  }
  row.dataset.scope = scope;
  row.dataset.t = key;
  row.textContent = say(key, english);
}

/* The chip's look lives in public/settings-kit.css: an inline <style> is refused by the page's Content Security Policy. */

let queued = false;
/**
 * Describes and chips everything, once per batch of changes to the page.
 *
 * Integration review (mac7/wake-pins): this used to wait 60ms. A card that draws its controls from
 * an answer — the Permissions page, renderModels' fallback checkboxes — therefore showed bare
 * controls for 60ms every time, with no description for a screen reader to read and none for
 * tests/settings-descriptions.test.mjs to find, which is why it failed about one run in three. A
 * microtask still batches a whole run of changes into one pass, but finishes before anything can
 * look at the page. The pass is idempotent (a control that is described already is left alone), so
 * the nodes it adds settle on the next pass instead of going round for ever.
 */
function refresh() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    describeAll();
    for (const card of document.querySelectorAll(CARDS)) chip(card);
  });
}

if (typeof document !== "undefined") {
  const watch = () => {
    const body = document.getElementById("lx-settings-body");
    if (!body) return false;
    new MutationObserver(refresh).observe(body, { childList: true, subtree: true });
    refresh();
    return true;
  };
  if (!watch()) {
    const wait = new MutationObserver(() => { if (watch()) wait.disconnect(); });
    wait.observe(document.body, { childList: true, subtree: true });
  }
  document.addEventListener("branch-language", () => {
    for (const node of document.querySelectorAll(".kit-describe[data-t], .kit-scope[data-t]"))
      node.textContent = say(node.dataset.t, node.textContent);
  });
  globalThis.branchDescribeSettings = () => refresh();
  /**
   * Integration review (mac7/wake-pins): the same, at once. A card that throws its controls away and
   * makes new ones (renderModels' fallback checkboxes) calls this straight after, so the new
   * controls are described before anybody — or any test — can look at them. Waiting for the
   * debounce above left them bare for 60ms, which is where tests/settings-descriptions.test.mjs
   * caught #models-form about one run in three.
   */
  globalThis.branchDescribeSettingsNow = () => {
    describeAll();
    for (const card of document.querySelectorAll(CARDS)) chip(card);
  };
}
