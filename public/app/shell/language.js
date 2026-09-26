/* The window's language is kept by the engine too (GET/POST /api/look "language", the same setting `branch theme language`
   changes), so a choice made in Settings › Appearance reaches a new browser and the terminal. public/i18n.js keeps this
   browser's copy (localStorage), so the first draw is already in the right words; once the engine's choice is read, it
   wins. "auto" (never chosen here, or "follow the computer" from the terminal) leaves this browser's choice as it is.
   Only a language with a locale file (i18n.js LANGUAGES) can be chosen. */

import { LANGUAGES, language, setLanguage } from "../../i18n.js";
import { api } from "../core/api.js";

export const canSpeak = (code) => LANGUAGES.some((l) => l.id === code);

/* While a choice is being saved, a look read just before it would put the old language back. */
let saving = 0;

/* Puts the engine's saved language on the page when it differs. True when the words changed. */
export async function followLook(look) {
  const want = look?.language;
  if (saving || !canSpeak(want) || want === language()) return false;
  await setLanguage(want);
  return true;
}

/* A choice made in Settings › Appearance: saved to the engine (the route changes only the language), then its words
   loaded and put on the page. Returns the engine's look as it now stands. */
export async function chooseLanguage(code) {
  saving += 1;
  try {
    const look = await api("look", { language: code });
    await setLanguage(code);
    return look;
  } finally {
    saving -= 1;
  }
}
