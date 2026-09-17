/**
 * Puts the window's theme on the phone's own screens. The Branch window tells the app which of the
 * 44 themes and which mode it is showing; this writes that theme's finished colours onto the page,
 * under Branch's own token names, exactly as public/layout.js does, and paints the oak behind.
 */
import { THEMES, TOKEN_NAMES } from "/theme-catalogue.js";

/* The same bridge as public/layout.js (tests/mobile-shell.test.mjs keeps the two in step). */
export const BRIDGE = {
  "--panel": "--glass-2", "--panel-2": "--glass", "--muted": "--text-2", "--faint": "--text-3",
  "--line-strong": "--line-2", "--selected": "--press", "--good": "--ok", "--good-tint": "--ok-tint",
  "--danger": "--bad", "--copper-low": "--copper-lo", "--rail-hover": "--press", "--bubble": "--copper-tint",
  "--composer-bg": "--glass-2", "--step-bg": "--well", "--border": "--line", "--text-dim": "--text-3",
};

export function applyTheme(look = {}) {
  const theme = THEMES.find((entry) => entry[0] === look.theme) ?? THEMES[0];
  const mode = look.mode === "light" ? "light" : "dark";
  const root = document.documentElement;
  if (mode === "light") root.dataset.theme = "daylight"; else delete root.dataset.theme;
  const values = theme[3][mode];
  const tokens = Object.fromEntries(TOKEN_NAMES.map((name, index) => [name, values[index]]).filter(([name, value]) => value && name !== "--blur"));
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) root.style.setProperty(name, tokens[from]);
  root.dataset.palette = theme[0];
  return { theme: theme[0], mode };
}

/** The oak, drawn by Branch's own public/grove.js; a phone without a canvas simply goes without. */
export async function paintOak(mode) {
  try {
    const grove = await import("/grove.js");
    grove.paint({ mode, season: grove.seasonToday() });
  } catch { /* the column still reads on the plain ground */ }
}
