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
  "desktop-enabled": ["settings-kit.info.when.screen", "Only when you want Branch to work other programs on this computer for you."],
  "browser-attach-enabled": ["settings-kit.info.when.borrow", "Only for one task that needs a site you are already signed in to."],
};

/* Every setting's value on a fresh install (public/settings-defaults.json, proven by the settings
   audit test), so "the way it ships" can say what that is, as the sample does. */
let shippedDefaults = null;
const loadDefaults = () => (shippedDefaults ??= fetch("/settings-defaults.json").then((r) => r.json()).then((d) => d.defaults ?? {}).catch(() => ({})));

/** The shipped value in words: the option's own name for a list, on/off for a switch, "empty" for nothing. */
function shippedWords(control, value) {
  if (value === "" || value === null) return say("settings-kit.info.shipped.empty", "empty");
  if (typeof value === "boolean") return value ? say("settings-kit.info.shipped.on", "on") : say("settings-kit.info.shipped.off", "off");
  const option = control.tagName === "SELECT" ? [...control.options].find((item) => item.value === String(value)) : null;
  if (option) return option.textContent.trim();
  if (value === "on" || value === "off") return shippedWords(control, value === "on");
  return String(value);
}

/** When you'd change it: a setting's own sentence, else the way it ships, named when it is known. */
function whenFor(control, defaults) {
  if (WHEN[control.id]) return say(...WHEN[control.id]);
  if (!(control.id in defaults)) return say("settings-kit.info.when.shipped-unknown", "If the way it ships doesn't suit you. You can always change it back.");
  const shipped = shippedWords(control, defaults[control.id]);
  const words = t("settings-kit.info.when.shipped", { shipped });
  return words === "settings-kit.info.when.shipped" ? `If the way it ships (${shipped}) doesn't suit you. You can always change it back.` : words;
}

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

/**
 * One label, in document order: the first label with words in it gets the control's "i". It walks
 * labels rather than controls because `control.labels` searches the whole document for a `for=`
 * label, and doing that for ~500 controls on every refresh kept the page too busy to answer a click
 * once every card was drawn. `label.control` is one lookup, and a label that already has its "i" is
 * passed over before anything else is read.
 */
function addInfo(label, seen) {
  const control = label.control;
  if (!control || seen.has(control) || !control.matches(CONTROLS) || !control.closest(CARDS)) return;
  if (isInfo(label.nextElementSibling)) { seen.add(control); return; }
  if (!nameOf(label)) return;
  seen.add(control);
  if (!sentenceOf(control)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kit-info";
  button.textContent = "i";
  // Not aria-haspopup: what opens holds words about this setting and nothing to do, so it is no
  // dialog and no menu. aria-expanded below says the words are showing; that is the whole truth.
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
  const seen = new Set();
  for (const label of document.querySelectorAll(`${CARDS} label`)) addInfo(label, seen);
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

/** Writes the popup for this "i" in the language now chosen. */
function fill(button, defaults) {
  const label = button.previousElementSibling;
  const control = label?.control;
  if (!control) return false;
  const name = line("p", nameOf(label), "kit-info-name");
  name.id = "kit-info-pop-name";
  pane.replaceChildren(
    name,
    line("b", say("settings-kit.info.what", "What this does")),
    line("p", sentenceOf(control)),
    line("b", say("settings-kit.info.when", "When you'd change it")),
    line("p", whenFor(control, defaults)));
  return true;
}

/** The "i" whose explanation is being fetched: a second press on it before it opens means "never mind". */
let opening = null;
/** How to take that press's cancel listeners off the document again, for whoever ends the wait. */
let stopOpening = null;

/**
 * While an explanation is still loading, whatever would close it once open cancels it instead:
 * Escape, or a press anywhere but its own "i" (another page, closing Settings). Answers the stop.
 */
function cancelOpeningOn(button) {
  // Removed on the first cancel as well as when the answer arrives: an answer that never comes
  // must not leave two document-wide listeners behind for every press.
  let listening = true;
  const stop = () => {
    if (!listening) return;
    listening = false;
    if (stopOpening === stop) stopOpening = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPress, true);
  };
  const cancel = () => { if (opening === button) opening = null; stop(); };
  /*
   * One Escape undoes one thing. Without consuming the key here it went on to layout.js, which shut
   * Settings: asking for an explanation and changing your mind closed the whole window. An
   * explanation that did open is already treated this way by public/popover.js, which calls
   * stopImmediatePropagation for the same reason, so this is the same rule applied a moment earlier.
   * Nothing here moves the keyboard. Pressing the "i" left it on the "i", so cancelling leaves it
   * there -- and if the person has since gone to another control, dragging them back to an
   * explanation they gave up on would be worse than the bug. Proved both ways below.
   */
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    cancel();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPress = (event) => { if (!button.contains(event.target)) cancel(); };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPress, true);
  return stop;
}

/**
 * Whether the "i" is still there to point the explanation at: on the page and not hidden.
 *
 * checkVisibility answers `display` on its own; `visibility` and `content-visibility` have to be
 * asked for, and an earlier comment here wrongly said otherwise, which is how an "i" hidden where it
 * stands kept its explanation open over it.
 *
 * Deliberately **not** "in view": none of these ask where the page is scrolled to, and that is the
 * rule we want -- see the scroll listener below.
 */
const onPage = (button) => button.isConnected
  && (button.checkVisibility?.({ visibilityProperty: true, contentVisibilityAuto: true })
    ?? button.getClientRects().length > 0);

/**
 * The "i" that now stands for the same setting. A card that redraws itself gives its label a new "i"
 * (infoAll above), so a press made just before that would otherwise be dropped with nothing on screen.
 */
function infoNowFor(control) {
  if (!control) return null;
  for (const button of document.querySelectorAll(`${CARDS} .kit-info`)) {
    const now = button.previousElementSibling?.control;
    // The card may have made a new control as well as a new label, so its own name counts as itself.
    if (!now || !onPage(button)) continue;
    if (now === control || (control.id && now.id === control.id) || (control.name && now.name === control.name)) return button;
  }
  return null;
}


/**
 * While the explanation is open it is the "i"'s own description, so a screen reader reads the whole
 * of it where the person asked for it, instead of being told a dialog opened and left to find it.
 * Whatever the "i" was described by before is kept and put back when it closes.
 */
function describeWith(button, paneId) {
  const before = button.getAttribute("aria-describedby");
  // The explanation opens with the setting's own name, which is what the "i" was described by
  // already, so this replaces rather than adds: appending read the name twice before the words.
  button.setAttribute("aria-describedby", paneId);
  return before;
}

/** Puts back what the "i" was described by before its explanation was opened. */
function describeAgain(button, before) {
  if (before) button.setAttribute("aria-describedby", before);
  else button.removeAttribute("aria-describedby");
}

async function toggleInfo(button) {
  if (shown?.button === button) { shown.entry.close(); return; }
  /* A second press on the same "i" before it opens means "never mind" -- and it must take that press's
     cancel listeners off the document itself. Its own onPress sees a press inside its own button and
     rightly does not cancel, and the answer it is waiting for may never come: on a dead network every
     other press then left a keydown and a pointerdown on the document for ever, and the next press
     added two more. */
  if (opening === button) { opening = null; stopOpening?.(); stopOpening = null; return; }
  opening = button;
  // Which setting was pressed, read before the wait, while its label is still there to name it.
  const label = button.previousElementSibling;
  const control = label?.control ?? null;
  const stop = cancelOpeningOn(button);
  stopOpening = stop;
  const defaults = await loadDefaults().finally(() => { if (stopOpening === stop) stopOpening = null; stop(); });
  // Only the latest press opens anything, and whatever it replaces is closed first: its close
  // hides the one shared pane, so running it after this one is shown would hide this one instead.
  if (opening !== button) return;
  opening = null;
  /* The card may have drawn itself again while it loaded, which gives the setting a new label and a new
     "i": the press belongs to the setting, so it opens against the "i" that stands for it now. An "i"
     taken off a label that is still there was taken away on purpose, and then nothing opens, as before. */
  if (!onPage(button)) {
    const again = label?.isConnected !== true ? infoNowFor(control) : null;
    if (!again) return;
    button = again;
  }
  if (shown) shown.entry.close();
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "kit-info-pop";
    pane.id = "kit-info-pop";
    /* Words about the control it is pointing at, and nothing to do in them: that is a tooltip, not a
       dialog. Calling it a dialog told a screen reader to expect something to act on and gave it
       none, and it left the words themselves reachable only by going and finding them. They are the
       "i"'s own description while it is open (describeWith below), so they are read where they are
       asked for. */
    pane.setAttribute("role", "tooltip");
    pane.hidden = true;
    document.body.append(pane);
  }
  if (!fill(button, defaults)) return;
  pane.hidden = false;
  place(button);
  button.setAttribute("aria-expanded", "true");
  const described = describeWith(button, pane.id);
  const entry = trackPopover(button, pane, () => {
    button.setAttribute("aria-expanded", "false");
    describeAgain(button, described);
    // The pane belongs to whichever "i" is showing now; a close that arrives late hides nothing else.
    if (shown?.button !== button) return;
    pane.hidden = true;
    shown = null;
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
    // An explanation belongs to its "i": once that has gone from the page, so does it.
    if (shown && !onPage(shown.button)) shown.entry.close();
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
    // An open explanation is written again in the new language, where it stands.
    if (shown && pane && !pane.hidden) void loadDefaults().then((defaults) => { if (shown && fill(shown.button, defaults)) place(shown.button); });
  });
  /*
   * The rule, in one line: **the explanation follows its "i" for as long as that "i" is on the page,
   * and goes when the "i" goes.** Scrolling is not a reason to take it away -- not even scrolling the
   * "i" clean off the screen, where the explanation goes with it and comes back with it.
   *
   * It reads as the odd choice until you have chased the flake: pressing an "i" makes the Settings
   * body scroll a moment later, all on its own, while the page is still settling. A rule of "close
   * when it leaves the view" threw away the explanation the person had just asked for, about one run
   * in three under load, with the "i" at y=2507 in a 1000px viewport. The page moving under you is
   * not you changing your mind. So: follow while it is there, close when it is gone.
   */
  document.addEventListener("scroll", (event) => {
    if (!shown || pane?.contains(event.target)) return;
    if (onPage(shown.button)) place(shown.button);
    // The rule's home is refresh() above; this is the same rule answered at once rather than on the
    // next pass. Measured: with this branch removed, an "i" hidden where it stands still takes its
    // explanation with it, in 200-600ms, through refresh(). It is kept as the immediate path, not
    // as a second opinion -- both ask onPage, so they cannot disagree.
    else shown.entry.close();
  }, true);
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
