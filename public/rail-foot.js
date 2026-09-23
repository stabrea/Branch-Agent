/* DG-094, DG-159, DG-161: the foot of the sidebar is one line of icons, as the approved sample's: the theme (all
   themes, in Settings › Appearance) and the pet's show/hide on the left, then day/night, clear the view and the
   Settings cog on the right. The account row under it keeps the owner's name alone (DG-095).
   The pet uses the same setting as Settings › Appearance; day/night flips between Forest and Daylight like the theme
   picker does. Words have data-t keys; no colour is written here. */
import { changeAppearance } from "/appearance.js";
import { on, onDelight, saveDelight, state } from "/delight-kit.js";
import { say } from "/strip.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const PATHS = {
  leaf: "M5 19c1-8 6-13 14-14-1 8-6 13-14 14zm0 0 7-7",
  paw: "M8 10a1.8 1.8 0 1 1 0-3.6A1.8 1.8 0 0 1 8 10zm8 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm-5-3a1.8 1.8 0 1 1 0-3.6A1.8 1.8 0 0 1 11 7zm2 0a1.8 1.8 0 1 1 0-3.6A1.8 1.8 0 0 1 13 7zm-1 13c-3 0-5-1.6-5-4s2.2-4 5-4 5 1.6 5 4-2 4-5 4z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
function iconButton(id, name) {
  const node = Object.assign(document.createElement("button"), { type: "button", id, className: "lx-foot-icon" });
  if (name) node.append(icon(name));
  return node;
}
/** A button's accessible name and, when it differs, the longer title shown under the pointer. */
function name(node, words, title = words) {
  node.setAttribute("aria-label", words);
  node.title = title;
}

const dark = () => root.dataset.theme !== "daylight";
const themeWord = (id) => say(`appearance.${id}`, id === "daylight" ? "Daylight" : "Forest");

function paint() {
  const now = dark() ? "forest" : "daylight", other = dark() ? "daylight" : "forest";
  const theme = $("lx-foot-theme"), mode = $("lx-foot-mode"), pet = $("lx-foot-pet"), eye = $("lx-foot-eye");
  if (!theme) return;
  name(theme, say("rail.foot.theme", "Theme · {name}", { name: themeWord(root.dataset.theme || "forest") }),
    say("rail.foot.themeTitle", "All themes, in Settings › Appearance"));
  mode.querySelector(".lx-foot-glyph").textContent = dark() ? "☾" : "☀";
  name(mode, say("rail.foot.mode", "{now}. Switch to {other}", { now: themeWord(now), other: themeWord(other) }),
    say("rail.foot.modeTitle", "Switch to {other}", { other: themeWord(other) }));
  const shown = on("pets"), petName = state.settings?.pets?.name || "Hazel";
  pet.hidden = !state.available;
  pet.setAttribute("aria-pressed", String(shown));
  name(pet, shown ? say("rail.foot.petHide", "{name} is here. Hide the pet", { name: petName }) : say("rail.foot.petShow", "Show the pet"));
  eye.setAttribute("aria-pressed", String(Boolean(root.dataset.quiet)));
  name(eye, say("look.clear", "Clear the view"), say("rail.foot.clearTitle", "Clear the view: show the background. Esc brings it back"));
}

function build() {
  const owner = $("owner-menu-button");
  if (!owner || $("lx-foot-line")) return;
  const line = Object.assign(document.createElement("div"), { id: "lx-foot-line", className: "lx-foot-line" });
  const theme = iconButton("lx-foot-theme", "leaf");
  theme.addEventListener("click", () => $("appearance-shortcut")?.click());
  const pet = iconButton("lx-foot-pet", "paw");
  pet.addEventListener("click", () => void saveDelight({ pets: { on: !on("pets") } }).then(paint));
  const mode = iconButton("lx-foot-mode");
  mode.append(Object.assign(document.createElement("span"), { className: "lx-foot-glyph" }));
  mode.querySelector(".lx-foot-glyph").setAttribute("aria-hidden", "true");
  mode.addEventListener("click", () => changeAppearance({ appearance: dark() ? "daylight" : "forest", followSystem: false }));
  const eye = iconButton("lx-foot-eye", "eye");
  eye.addEventListener("click", () => $("lx-clear")?.click());
  line.append(theme, pet, mode, eye);
  /* the Settings cog joins the line on the far right, so the account row is the name alone */
  for (const gear of [$("lx-settings-row"), $("rail-settings")]) if (gear) line.append(gear);
  (owner.closest(".sg-foot-line") ?? owner).before(line);
  /* the cog says whether Settings is open, as it did beside the account row */
  const expanded = () => { for (const gear of line.querySelectorAll(".sg-gear")) gear.setAttribute("aria-expanded", String(!$("settings-window")?.hidden)); };
  if ($("settings-window")) new MutationObserver(expanded).observe($("settings-window"), { attributes: true, attributeFilter: ["hidden"] });
  expanded();
  paint();
}

/* after public/settings-grown.js has put the cog beside the account row, so it is moved once and stays */
if (document.body.classList.contains("sg-ready")) build();
else new MutationObserver((_, observer) => {
  if (!document.body.classList.contains("sg-ready")) return;
  observer.disconnect();
  build();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
onDelight(paint);
document.addEventListener("branch-appearance", paint);
document.addEventListener("branch-language", paint);
new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ["data-quiet", "data-theme"] });
