/* Appearance settings: theme, highlight colour, text size, spacing, lettering,
   movement and the acorn. Every change shows at once; Save keeps it for next time.
   The record matches PreferencesSchema in src/preferences.ts. */
import { t } from "/i18n.js";

export const defaultAppearance = {
  appearance: "forest",
  followSystem: false,
  accent: "copper",
  textSize: "medium",
  density: "comfortable",
  font: "geist",
  reduceMotion: false,
  showAcorn: true,
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
  render();
}

function render() {
  if (!$("appearance")) return;
  $("appearance").value = current.appearance;
  $("appearance-follow").checked = current.followSystem;
  $("appearance").disabled = current.followSystem;
  $("appearance-motion").checked = current.reduceMotion;
  $("appearance-acorn").checked = current.showAcorn;
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

function change(patch) {
  applyAppearance({ ...current, ...patch });
  void persist(current).catch(() => {});
}

/** Called once by public/app.js with the way to save a preferences record. */
export function initAppearance(save) {
  persist = save;
  for (const [key, id] of Object.entries(GROUPS))
    $(id).replaceChildren(...CHOICES[key].map(([value]) => choiceButton(key, value)));
  $("appearance").addEventListener("change", () =>
    change({ appearance: $("appearance").value }),
  );
  $("appearance-follow").addEventListener("change", () =>
    change({ followSystem: $("appearance-follow").checked }),
  );
  $("appearance-motion").addEventListener("change", () =>
    change({ reduceMotion: $("appearance-motion").checked }),
  );
  $("appearance-acorn").addEventListener("change", () =>
    change({ showAcorn: $("appearance-acorn").checked }),
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
