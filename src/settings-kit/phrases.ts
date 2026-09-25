/**
 * Dogfood B20: the words people use for a setting when they are not the words on its card. "Turn on
 * automatic updates" matched nothing in the catalogue, so Branch asked "which setting do you mean?"
 * with nothing to choose from. settings.find (src/settings-kit/clarify.ts) reads these phrases after
 * the catalogue's own names, labels and window words, as whole words, so a phrase can add a setting
 * to what the names found but never take one away.
 *
 * A phrase for a setting the catalogue does not hold says where the owner changes it instead.
 * Updating by itself and the update channel are the owner's own: their card asks for the owner in
 * the window (src/comfort/api.ts), and no conversation, preset or file sets them
 * (src/settings-kit/catalogue.ts, neverTouched). Should one of them join the catalogue, the same
 * phrases find it there, and settings.find plans it like any other setting.
 *
 * The window's look is the owner's own as well: Day or night and Text size, in Settings, Appearance,
 * Theme and lettering (public/layout.js, public/appearance.js). Both are saved with the window's
 * preferences (src/preferences.ts), which the catalogue does not hold, so no settings tool changes
 * them. Their names and choices are the words the window shows (public/locales/en.json).
 */
export interface SettingPhrase {
  /** Whole phrases, as people say them; "updates" reads as "update". */
  says: readonly string[];
  /** The setting they mean, as settings.change names it (key.field). */
  setting: string;
  /** For a setting only the owner changes, at its own card: its name there, the way to it, and its choices. */
  owners?: { name: string; where: string; place: string; choices: string };
  /**
   * Broad words, said of other things too: the appearance of the status line, a dark mode for a website. Beside a word
   * that names one of Branch's settings, they are about that setting, so settings.find asks about it rather than naming
   * this card; and they count as a request about Branch's settings only when it is aimed at Branch (src/settings-kit/clarify.ts).
   */
  broad?: true;
}

export const settingPhrases: readonly SettingPhrase[] = [
  { says: ["automatic update", "automatic updating", "auto update", "autoupdate", "update automatically", "updating automatically",
    "update by itself", "updating by itself", "update itself", "update on its own", "self update", "self updating"],
    setting: "comfort-notify.autoUpdate",
    owners: { name: "Updating by itself", where: "settings:about", place: "Settings, Updates & about, Updating by itself", choices: "off, check or install" } },
  { says: ["update channel", "release channel", "beta channel", "dev channel", "stable channel", "beta build", "dev build"],
    setting: "comfort-notify.releaseChannel",
    owners: { name: "Update channel", where: "settings:about", place: "Settings, Updates & about, Update channel", choices: "stable, beta or dev" } },
  { says: ["dark mode", "light mode", "night mode", "dark theme", "light theme", "theme", "appearance"], broad: true,
    setting: "preferences.appearance",
    owners: { name: "Day or night", where: "settings:appearance", place: "Settings, Appearance, Theme and lettering, Day or night",
      choices: "Follow this computer, Moonlight or Daylight" } },
  { says: ["text size", "font size", "bigger text", "text bigger", "larger text", "text larger", "smaller text", "text smaller"], broad: true,
    setting: "preferences.textSize",
    owners: { name: "Text size", where: "settings:appearance", place: "Settings, Appearance, Theme and lettering, Text size",
      choices: "Small, Medium or Large" } },
  { says: ["computer use", "control my computer", "control the computer", "mouse and keyboard"], setting: "desktop-control.mode" },
  { says: ["telemetry"], setting: "asks-analytics.mode" },
  { says: ["telemetry"], setting: "execution-metrics.mode" },
];
