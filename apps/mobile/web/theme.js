/**
 * Puts the window's theme on the phone's own screens. The Branch window tells the app which of the
 * 44 themes and which mode it is showing; this writes that theme's finished colours onto the page,
 * under Branch's own token names with the phone's copy of the window's theme bridge (web/theme-bridge.js), and paints the oak behind.
 */
import { themeById, tokensFor, wearTokens } from "/theme-bridge.js";

export function applyTheme(look = {}) {
  const theme = themeById(look.theme);
  const mode = look.mode === "light" ? "light" : "dark";
  const root = document.documentElement;
  if (mode === "light") root.dataset.theme = "daylight"; else delete root.dataset.theme;
  wearTokens(root, theme, tokensFor(theme, mode));
  return { theme: theme[0], mode };
}

/** The oak, drawn by the phone's copy of Branch's grove (web/grove.js); a phone without a canvas simply goes without. */
export async function paintOak(mode) {
  try {
    const grove = await import("/grove.js");
    grove.paint({ mode, season: grove.seasonToday() });
  } catch { /* the column still reads on the plain ground */ }
}
