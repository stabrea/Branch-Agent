/** What every phone screen shares: the native plugin, the words, and which screen is showing. */
import { t } from "/i18n.js";

export const $ = (id) => document.getElementById(id);
/**
 * The native side (BranchPhone), reached through the bridge Capacitor puts on every app page
 * (`nativePromise`), so the page needs no bundled copy of @capacitor/core. In the screen tests a
 * stand-in takes its place.
 */
function nativePlugin(cap = globalThis.Capacitor) {
  if (!cap?.nativePromise || !cap.PluginHeaders?.some((header) => header.name === "BranchPhone")) return null;
  const call = (method) => (options) => cap.nativePromise("BranchPhone", method, options ?? {});
  return new Proxy({}, { get: (_, method) => (typeof method === "string" && method !== "then" ? call(method) : undefined) });
}
export const plugin = nativePlugin() ?? globalThis.branchPhoneFake ?? null;
const fill = (text, values) => (values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text);
/** A word from the language file, or the English given here when that file has no such key. */
export const say = (key, english, values) => { const word = t(key, values); return word === key ? fill(english, values) : word; };
export function status(id, text, bad = false) {
  $(id).textContent = text;
  $(id).classList.toggle("bad", bad);
}
export function show(screen) {
  for (const id of ["screen-pair", "screen-lock", "screen-home"]) $(id).hidden = id !== screen;
}
/** The page's one piece of state: the vault once the plugin is known, and what was shared in. */
export const phone = { vault: null, shared: [] };
/** An error in the chosen language when it carries a key, otherwise the words it came with. */
export const describe = (error) => (error?.key ? say(error.key, error.message) : String(error?.message ?? error));
