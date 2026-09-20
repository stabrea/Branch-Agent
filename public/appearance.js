/* Appearance settings: theme, highlight colour, text size, spacing, lettering,
   movement and the acorn, and how much of the window shows (the calm window, or everything, and
   the voice buttons). Every change shows at once; Save keeps it for next time.
   The record matches PreferencesSchema in src/preferences.ts. */
import { t } from "/i18n.js";
import { switchControl, dropdown } from "/control-makers.js";

export const defaultAppearance = {
  appearance: "forest",
  followSystem: false,
  accent: "copper",
  textSize: "medium",
  density: "comfortable",
  font: "geist",
  reduceMotion: false,
  showAcorn: false,
  showEverything: false,
  showVoice: false,
  /* phase2/panels (public/panels-hide.js) */
  seeThrough: 30,
  conversationWidth: "wide",
  hidden: [],
  rightClickHide: false,
};

/* Wave 7: the buttons name their words with a key, so another language covers them too. */
const CHOICES = {
  accent: [["copper"], ["leaf"], ["earth"], ["slate"], ["ink"]],
  textSize: [["small"], ["medium"], ["large"]],
  density: [["comfortable"], ["compact"]],
  font: [["geist"], ["system"]],
};
const GROUPS = {
  accent: "accent-choices",
  textSize: "text-size-choices",
  density: "density-choices",
  font: "font-choices",
};
/* Switches that may sit on any Settings page but belong to this same record. */
const SWITCHES = [["appearance-everything", "showEverything"], ["appearance-voice", "showVoice"]];
const darkQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
const $ = (id) => document.getElementById(id);
let current = { ...defaultAppearance };
let persist = async () => {};

/** The theme actually shown, once "follow this computer" is taken into account. */
export function resolvedTheme(value) {
  if (!value.followSystem) return value.appearance;
  return darkQuery?.matches === false ? "daylight" : "forest";
}

/** Write the whole look onto <html>. tokens.css does the rest. */
export function applyAppearance(value) {
  current = { ...defaultAppearance, ...value };
  const root = document.documentElement.dataset;
  root.theme = resolvedTheme(current);
  root.accent = current.accent;
  root.textSize = current.textSize;
  root.density = current.density;
  root.font = current.font;
  if (current.reduceMotion) root.motion = "reduced";
  else delete root.motion;
  root.acorn = current.showAcorn ? "on" : "off";
  /* The calm window is the default; layout.css hides the rest unless this says "on". */
  root.everything = current.showEverything ? "on" : "off";
  root.voice = current.showVoice ? "on" : "off";
  root.convw = current.conversationWidth; // phase2/panels
  render();
  document.dispatchEvent(new CustomEvent("branch-appearance", { detail: { ...current } })); // phase2/panels
}
/** phase2/panels (and phase2/settings, for the Settings level): a change made from anywhere, saved like one made here. */
export const changeAppearance = (patch) => change(patch);

function render() {
  if (!$("appearance")) return;
  $("appearance").value = current.appearance;
  if ($("appearance-follow")) $("appearance-follow").checked = current.followSystem;
  $("appearance").disabled = current.followSystem;
  if ($("appearance-motion")) $("appearance-motion").checked = current.reduceMotion;
  if ($("appearance-acorn")) $("appearance-acorn").checked = current.showAcorn;
  for (const [id, key] of SWITCHES) {
    const el = $(id);
    if (el && el.getAttribute("role") === "switch") {
      el.checked = current[key];
      el.setAttribute("aria-checked", String(current[key]));
    }
  }
  for (const [key, id] of Object.entries(GROUPS))
    for (const button of $(id).children)
      button.setAttribute("aria-pressed", String(button.value === current[key]));
}

function choiceButton(key, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "choice";
  button.value = value;
  if (key === "accent") {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.dataset.swatch = value;
    button.append(swatch);
  }
  /* i18n.js writes this word again whenever the language changes. */
  const word = document.createElement("span");
  word.dataset.t = `appearance.${key}.${value}`;
  word.textContent = t(word.dataset.t);
  button.append(word);
  button.addEventListener("click", () => change({ [key]: value }));
  return button;
}

/* Changes are saved one after another, so the last one made is the last one kept. */
let saving = Promise.resolve();
let unsaved = 0;
/** How many changes this window has made, so a look asked for before one of them is known to be older. */
let made = 0;
export const appearanceChanges = () => made;
function change(patch) {
  made += 1;
  applyAppearance({ ...current, ...patch });
  const value = { ...current };
  unsaved += 1;
  saving = saving.then(() => persist(value)).catch(() => {}).finally(() => { unsaved -= 1; });
}

/**
 * The look as saved, from the window's regular refresh. While this window's own changes are still
 * being saved it can only be older than what is on screen: applying it then undid the choices made
 * after it, and the next save sent the undone value back (a lettering choice came back as the
 * default in shell-ui). So it is taken only once nothing here is waiting to be saved.
 */
/* ci-flakes-3: nor when a change was made here after the refresh asked (`since`). Its answer could arrive
   after that change had been saved, and put the look from before it back on screen. */
export function adoptSaved(value, since = made) {
  if (unsaved === 0 && since === made) applyAppearance(value);
}

/** Called once by public/app.js with the way to save a preferences record. */
export function initAppearance(save) {
  persist = save;
  for (const [key, id] of Object.entries(GROUPS))
    $(id).replaceChildren(...CHOICES[key].map(([value]) => choiceButton(key, value)));

  // Convert appearance checkbox to switch if it exists as HTML
  const followEl = $("appearance-follow");
  if (followEl && followEl.tagName === "INPUT" && followEl.type === "checkbox") {
    const wrapper = followEl.parentElement;
    const sw = switchControl({
      id: "appearance-follow",
      checked: current.followSystem,
      onChange: (checked) => change({ followSystem: checked }),
    });
    const label = document.createElement("label");
    label.className = "check-row";
    const span = document.createElement("span");
    span.dataset.t = "appearance.followSystem";
    span.textContent = t("appearance.followSystem");
    label.append(sw, span);
    wrapper?.replaceWith(label);
  } else {
    const sw = $("appearance-follow");
    if (sw) sw.addEventListener("change", () =>
      change({ followSystem: sw.checked }),
    );
  }

  const motionEl = $("appearance-motion");
  if (motionEl && motionEl.tagName === "INPUT" && motionEl.type === "checkbox") {
    const wrapper = motionEl.parentElement;
    const sw = switchControl({
      id: "appearance-motion",
      checked: current.reduceMotion,
      onChange: (checked) => change({ reduceMotion: checked }),
    });
    const label = document.createElement("label");
    label.className = "check-row";
    const span = document.createElement("span");
    span.dataset.t = "appearance.reduceMotion";
    span.textContent = t("appearance.reduceMotion");
    label.append(sw, span);
    wrapper?.replaceWith(label);
  } else {
    const sw = $("appearance-motion");
    if (sw) sw.addEventListener("change", () =>
      change({ reduceMotion: sw.checked }),
    );
  }

  const acornEl = $("appearance-acorn");
  if (acornEl && acornEl.tagName === "INPUT" && acornEl.type === "checkbox") {
    const wrapper = acornEl.parentElement;
    const sw = switchControl({
      id: "appearance-acorn",
      checked: current.showAcorn,
      onChange: (checked) => change({ showAcorn: checked }),
    });
    const label = document.createElement("label");
    label.className = "check-row";
    const span = document.createElement("span");
    span.dataset.t = "appearance.showAcorn";
    span.textContent = t("appearance.showAcorn");
    label.append(sw, span);
    wrapper?.replaceWith(label);
  } else {
    const sw = $("appearance-acorn");
    if (sw) sw.addEventListener("change", () =>
      change({ showAcorn: sw.checked }),
    );
  }

  for (const [id, key] of SWITCHES) {
    const el = $(id);
    if (!el) continue;
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      const wrapper = el.parentElement;
      const sw = switchControl({
        id,
        checked: current[key],
        onChange: (checked) => change({ [key]: checked }),
      });
      const label = document.createElement("label");
      label.className = "check-row";
      const span = document.createElement("span");
      const tkey = id.replace(/-/g, ".").replace("appearance.", "appearance.");
      span.dataset.t = tkey;
      span.textContent = t(tkey);
      label.append(sw, span);
      wrapper?.replaceWith(label);
    } else {
      el.addEventListener("change", () => change({ [key]: el.checked }));
    }
  }

  $("appearance").addEventListener("change", () =>
    change({ appearance: $("appearance").value }),
  );

  darkQuery?.addEventListener("change", () => {
    if (current.followSystem) applyAppearance(current);
  });
  applyAppearance(current);
}

/** What the Save button sends. */
export function currentAppearance() {
  return { ...current };
}
