/* phase2/delight: what the pet, the achievements and your own background share — the owner's switches
   as the server keeps them (src/delight.ts), words, and a few small builders. Anybody other than the
   owner at this window is told only that there is nothing here for them, and sees none of it. */
import { api } from "/app.js";
import { t } from "/i18n.js";

const fill = (text, values) => (values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text);
/** A word from the language file, or the English given here while that file is still loading. */
export const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? fill(english, values) : word;
};
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
/** "Keep things still" in Appearance, or the computer's own reduced-motion setting. */
export const still = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";

export const state = { available: false, settings: null, earned: 0, rank: "Bronze" };
const listeners = new Set();
export const onDelight = (listener) => listeners.add(listener);
const tell = () => { for (const listener of listeners) { try { listener(state); } catch (error) { console.warn(error); } } };

const unlocked = () => document.getElementById("workspace")?.hidden === false && Boolean(sessionStorage.getItem("branch-token"));
export async function loadDelight() {
  if (!unlocked()) return;
  try {
    const answer = await api("delight");
    Object.assign(state, { available: answer.available === true, settings: answer.settings ?? null, earned: answer.earned ?? 0, rank: answer.rank ?? "Bronze" });
  } catch {
    Object.assign(state, { available: false, settings: null });
  }
  tell();
}
/** Changes one or more switches, e.g. { pets: { on: true } }, and tells every part of the window. */
export async function saveDelight(patch) {
  const answer = await api("delight/settings", patch);
  state.settings = answer.settings;
  tell();
  document.dispatchEvent(new CustomEvent("branch-delight-noticed"));
  return answer.settings;
}
export const on = (part) => state.available && state.settings?.[part]?.on === true;
/** Tells the owner's record something the window really saw. Only while achievements are on. */
export async function notice(body) {
  if (!on("achievements")) return;
  try { await api("delight/noticed", body); } catch { return; }
  document.dispatchEvent(new CustomEvent("branch-delight-noticed"));
}
