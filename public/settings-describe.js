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
import { trackPopover } from "/popover.js";

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

function descriptionAnchor(control) {
  const segmented = control.closest(".segmented-control");
  const label = control.closest("label");
  return segmented ?? (label && label.contains(control) ? label : control);
}

/** Puts one sentence under a control (or under the label it sits in), unless it has one already. */
function attach(control, key, english) {
  if (described(control)) return;
  const anchor = descriptionAnchor(control);
  const next = nextAfter(anchor);
  if (next?.classList.contains("kit-describe") && next.dataset.t === key) return link(control, next);
  const node = note(key, english);
  endOf(anchor).after(node);
  link(control, node);
}

/** A row like "#models-fallback input" describes a group: one sentence after the group, shared. */
function attachGroup(selector, key, english) {
  const [group, inner] = selector.split(/ (.*)/s, 2);
  const holder = document.querySelector(group);
  if (!holder?.closest(CARDS)) return;
  const controls = [...holder.querySelectorAll(inner)].filter((control) => !described(control));
  if (!controls.length) return;
  let node = nextAfter(holder);
  if (!(node?.classList.contains("kit-describe") && node.dataset.t === key)) {
    node = note(key, english);
    endOf(holder).after(node);
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
    const next = nextAfter(descriptionAnchor(control));
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
    row.className = "kit-scope sr-only";
    const heading = card.querySelector(":scope > h2");
    const purpose = heading?.nextElementSibling?.tagName === "P" ? heading.nextElementSibling : heading;
    if (purpose) purpose.after(row); else card.prepend(row);
  }
  row.dataset.scope = scope;
  row.dataset.t = key;
  row.textContent = say(key, english);
}

/**
 * DG-010: the sample shows no scope chip, so the chip is `sr-only` -- invisible on screen, still
 * read aloud. The sample is a visual mock and can say nothing about text that is never seen, and
 * "how far this setting reaches" is real information a screen-reader user would otherwise lose.
 */
function chipAll() {
  for (const card of document.querySelectorAll(CARDS)) chip(card);
}

/* The chip's look lives in public/settings-kit.css: an inline <style> is refused by the page's Content Security Policy. */

/* ---------- the "i" beside a setting's name ---------- */

/**
 * The sample puts a small "i" after every setting's name. Pressing it shows the name, what the setting
 * does (the same sentence as the note under it) and when you would change it.
 *
 * The "i" sits straight after the <label>, never inside it: a button inside a label becomes part of
 * the control's name, so "Start Branch when I sign in to Windows" would be read aloud, and found by
 * tests, as "... About Start Branch ...". A control with no named label, or no sentence, gets no "i".
 *
 * Its name is "About this setting", and the label is its description (aria-describedby), so a screen
 * reader hears which setting it belongs to. It is not named "About <the setting>": a name that holds
 * the setting's words is found by a loose `getByLabel("Preset")` beside the real control, and it goes
 * stale when a card rewrites its label (the sign-in switch names this computer's system). A
 * description that points at the label cannot go stale.
 */
const ABOUT = ["settings-kit.info.about-this", "About this setting"];
let labelled = 0;
const WHEN = {
  "phone-switch": ["settings-kit.info.when.phone", "Switch it on when you want to use Branch from your phone."],
  "wake-word-mode": ["settings-kit.info.when.wake", "When you want to start talking without touching anything."],
  "dictation-mode": ["settings-kit.info.when.dictation", "When you would rather speak than type."],
  "retention-enabled": ["settings-kit.info.when.retention", "When conversations are taking up too much room."],
};
const WHEN_SHIPPED = ["settings-kit.info.when.shipped", "If the way it ships doesn't suit you. You can always change it back."];

const isInfo = (node) => !!node?.classList.contains("kit-info");
/** The element after `node`, stepping over an "i". */
const nextAfter = (node) => (isInfo(node.nextElementSibling) ? node.nextElementSibling.nextElementSibling : node.nextElementSibling);
/** Where something added after `node` goes: after its "i" when it has one. */
const endOf = (node) => (isInfo(node.nextElementSibling) ? node.nextElementSibling : node);

/** A label's own words, without the words of any control inside it. */
function nameOf(label) {
  const copy = label.cloneNode(true);
  for (const inner of copy.querySelectorAll("input, select, textarea, button")) inner.remove();
  return copy.textContent.replace(/\s+/g, " ").trim();
}

/** The words the control's described-by list points at. */
function sentenceOf(control) {
  const ids = (control?.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(" ");
}

/** Points the "i" at its label, giving the label an id when it has none. */
function describeBy(button, label) {
  if (!label.id) label.id = `kit-info-label-${++labelled}`;
  if (button.getAttribute("aria-describedby") !== label.id) button.setAttribute("aria-describedby", label.id);
}

function addInfo(control) {
  const label = [...(control.labels ?? [])].find((node) => nameOf(node));
  if (!label || isInfo(label.nextElementSibling) || !sentenceOf(control)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kit-info";
  button.textContent = "i";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", say(...ABOUT));
  describeBy(button, label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleInfo(button);
  });
  label.after(button);
  label.classList.add("kit-info-named");
}

/**
 * Gives every named, described control its "i", drops any "i" whose label has gone, and re-points an
 * "i" whose label a card replaced with a new one.
 */
function infoAll() {
  for (const button of document.querySelectorAll(`${CARDS} .kit-info`)) {
    const label = button.previousElementSibling;
    if (label?.tagName === "LABEL") describeBy(button, label);
    else button.remove();
  }
  for (const control of document.querySelectorAll(`${CARDS} :is(${CONTROLS})`)) addInfo(control);
}

let pane = null;
let shown = null;

function line(tag, words, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = words;
  return node;
}

/** Below the "i" when there is room, above it when there is not; never off the side of the window. */
function place(button) {
  const box = button.getBoundingClientRect();
  pane.style.left = `${Math.max(8, Math.min(box.left, innerWidth - pane.offsetWidth - 8))}px`;
  if (innerHeight - box.bottom >= pane.offsetHeight + 12 || innerHeight - box.bottom >= box.top) {
    pane.style.top = `${box.bottom + 6}px`;
    pane.style.bottom = "";
  } else {
    pane.style.top = "";
    pane.style.bottom = `${innerHeight - box.top + 6}px`;
  }
}

function toggleInfo(button) {
  if (shown?.button === button) { shown.entry.close(); return; }
  const label = button.previousElementSibling;
  const control = label?.control;
  if (!control) return;
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "kit-info-pop";
    pane.setAttribute("role", "dialog");
    pane.hidden = true;
    document.body.append(pane);
  }
  const name = line("p", nameOf(label), "kit-info-name");
  name.id = "kit-info-pop-name";
  pane.setAttribute("aria-label", say(...ABOUT));
  pane.setAttribute("aria-describedby", name.id);
  pane.replaceChildren(
    name,
    line("b", say("settings-kit.info.what", "What this does")),
    line("p", sentenceOf(control)),
    line("b", say("settings-kit.info.when", "When you'd change it")),
    line("p", say(...(WHEN[control.id] ?? WHEN_SHIPPED))));
  pane.hidden = false;
  place(button);
  button.setAttribute("aria-expanded", "true");
  const entry = trackPopover(button, pane, () => {
    pane.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (shown?.button === button) shown = null;
  });
  shown = { button, entry };
}

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
    chipAll();
    infoAll();
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
    for (const button of document.querySelectorAll(".kit-info")) button.setAttribute("aria-label", say(...ABOUT));
  });
  /* The explanation is placed against the "i"; once the page scrolls under it, it would point at nothing. */
  document.addEventListener("scroll", (event) => { if (shown && !pane?.contains(event.target)) shown.entry.close(); }, true);
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
    chipAll();
    infoAll();
  };
}
