/* The dashboard wears exactly what the window wears: the owner's light or dark choice (saved with
   the workspace), and the KeepOak theme, season and contrast this browser remembers (the same local
   storage keys public/layout.js writes). layout.js keeps its theme code to itself and loads the whole
   app with it, so the few lines that hand a theme's colours to Branch's own token names are repeated
   here, from the same catalogue, rather than pulled out of a file this page cannot load. */
import { applyAppearance } from "/appearance.js";
import { THEMES, TOKEN_NAMES } from "/theme-catalogue.js";
import { paint as paintGrove, seasonToday } from "/grove.js";

const root = document.documentElement;
const remembered = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
/* Branch's own token names, each fed from the KeepOak token that means the same (as layout.js BRIDGE). */
const BRIDGE = {
  "--panel": "--glass-2", "--panel-2": "--glass", "--muted": "--text-2", "--faint": "--text-3",
  "--line-strong": "--line-2", "--selected": "--press", "--good": "--ok", "--good-tint": "--ok-tint",
  "--danger": "--bad", "--copper-low": "--copper-lo", "--border": "--line", "--text-dim": "--text-3",
};

function rgbOf(hex) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) : null;
}
/** An opaque surface a step off the ground, for menus and the sign-in card. */
function solid(ground, toward, amount) {
  const from = rgbOf(ground), to = rgbOf(toward);
  if (!from || !to) return ground;
  return `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * amount)).join(", ")})`;
}

/** Writes the chosen theme's colours for the mode showing, then paints the oak in its season. */
function applyTheme() {
  const family = THEMES.find((theme) => theme[0] === (remembered("branch-palette") || "forest")) ?? THEMES[0];
  const mode = root.dataset.theme === "daylight" ? "light" : "dark";
  const more = remembered("branch-contrast") === "more" ? "-more" : "";
  const values = family[3][`${mode}${more}`] ?? family[3][mode];
  const tokens = Object.fromEntries(TOKEN_NAMES.map((name, index) => [name, values[index]])
    .filter(([name, value]) => value && name !== "--blur"));
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) root.style.setProperty(name, tokens[from]);
  const light = mode === "light";
  /* Toward the theme's own paper in light mode, so no colour is written down in this file. */
  root.style.setProperty("--surface", solid(tokens["--ground"], light ? tokens["--paper-2"] : tokens["--text"], light ? 0.55 : 0.07));
  root.dataset.palette = family[0];
  paintGrove({ mode, season: remembered("branch-season") || seasonToday() });
}

let saved = null;
/** Called with the workspace's appearance record whenever the summary brings one. */
export function wearLook(appearance) {
  const key = JSON.stringify(appearance ?? {});
  if (key === saved) return;
  saved = key;
  applyAppearance(appearance ?? {});
  applyTheme();
}

/* Following the computer's light or dark means changing with it, as the window does. */
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (saved === null) return;
  const appearance = JSON.parse(saved);
  if (appearance.followSystem) { applyAppearance(appearance); applyTheme(); }
});
/* Another tab of this browser picked a theme: wear it here too. */
addEventListener("storage", (event) => {
  if (["branch-palette", "branch-season", "branch-contrast"].includes(event.key ?? "")) applyTheme();
});
wearLook(null);
