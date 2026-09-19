/* phase2/delight: the playful extras, all off until the owner switches them on — a pet beside the acorn
   (public/delight-pet.js), achievements (public/delight-achievements.js) and your own background
   (public/delight-background.js). This file draws their three cards in Settings › Appearance, loads the
   owner's switches, and tells the owner's own record what the window really saw (a theme worn, the
   acorn turned) while achievements are on. Nobody but the owner sees any of it. */
import { displayView, toast } from "/app.js";
import { el, loadDelight, notice, on, onDelight, say, saveDelight, state, still } from "/delight-kit.js";
import { drawPet, PET_ART, PET_NAMES } from "/delight-pet.js";
import { openSheet, preview, TIERS } from "/delight-achievements.js";
import { chooseBackground, chooseBuiltIn, forgetBackground, LIMITS, savedBackground } from "/delight-background.js";
import { seasonToday } from "/grove.js";
import { acornModel, view3d } from "/delight-3d.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/* ---------- small builders ---------- */
function checkRow(id, key, english, change) {
  const row = el("label", "check-row"), box = el("input");
  box.type = "checkbox";
  box.id = id;
  box.addEventListener("change", () => void change(box.checked).catch((error) => said(error.message)));
  row.append(box, el("span", "", say(key, english)));
  return row;
}
function card(id, key, english, noteKey, note) {
  const box = el("section", "card delight-card");
  box.id = id;
  box.dataset.home = "settings:appearance";
  box.append(el("h2", "", say(key, english)), el("p", "field-note", say(noteKey, note)));
  return box;
}
function part(id) {
  const box = el("div", "delight-part");
  box.id = id;
  return box;
}
const said = (words) => toast(words);
function statusLine(id) {
  const line = el("p", "delight-said");
  line.id = id;
  line.setAttribute("role", "status");
  return line;
}

/* ---------- the pet's card ---------- */
function petCard() {
  const box = card("delight-pet-card", "delight.pet.title", "A pet", "delight.pet.note",
    "A small forest creature that sits beside the acorn in the corner of the side list. It shows what Branch is doing and, if you let it, gives a short tip now and then. Right-click it for its own menu.");
  const more = part("delight-pet-more"), tiles = el("div", "delight-pets");
  tiles.setAttribute("role", "group");
  tiles.setAttribute("aria-label", say("delight.pet.which", "Which pet"));
  for (const kind of Object.keys(PET_ART)) {
    const tile = el("button", "delight-pet-tile"), art = el("canvas");
    tile.type = "button";
    tile.dataset.kind = kind;
    art.setAttribute("aria-hidden", "true");
    tile.append(art, el("span", "", say(`delight.pet.kind.${kind}`, PET_NAMES[kind])));
    tile.addEventListener("click", () => void saveDelight({ pets: { kind } }));
    tiles.append(tile);
  }
  const nameRow = el("label", "delight-field"), name = el("input");
  name.id = "delight-pet-name";
  name.maxLength = 20;
  name.autocomplete = "off";
  name.addEventListener("change", () => void saveDelight({ pets: { name: name.value.trim() || "Hazel" } }));
  nameRow.append(el("span", "", say("delight.pet.name", "Its name")), name);
  more.append(tiles, nameRow,
    checkRow("delight-pet-talks", "delight.pet.talks", "Talks: one small bubble at a time, in plain words", (v) => saveDelight({ pets: { talks: v } })),
    checkRow("delight-pet-tips", "delight.pet.tips", "Tips now and then (fewer as your rank rises)", (v) => saveDelight({ pets: { tips: v } })));
  box.append(styleRow(), checkRow("delight-pet-on", "delight.pet.on", "Show a pet in the corner", (v) => saveDelight({ pets: { on: v } })), more);
  return box;
}
/** Pixel (the default) or 3D, for the acorn and the pet together. */
function styleRow() {
  const row = el("label", "delight-field"), select = el("select");
  select.id = "delight-style";
  for (const [value, key, english] of [["pixel", "delight.look.pixel", "Pixels, like the acorn has always been"], ["3d", "delight.look.3d", "3D"]])
    select.append(Object.assign(el("option", "", say(key, english)), { value }));
  select.addEventListener("change", () => void saveDelight({ look: { style: select.value } }));
  row.append(el("span", "", say("delight.look.label", "How the acorn and the pet are drawn")), select);
  return row;
}
function paintPetCard() {
  const pets = state.settings?.pets;
  if (!pets) return;
  $("delight-pet-on").checked = pets.on;
  $("delight-style").value = state.settings.look?.style ?? "pixel";
  $("delight-pet-more").hidden = !pets.on;
  $("delight-pet-talks").checked = pets.talks;
  $("delight-pet-tips").checked = pets.tips;
  if (document.activeElement !== $("delight-pet-name")) $("delight-pet-name").value = pets.name;
  for (const tile of document.querySelectorAll(".delight-pet-tile")) {
    tile.setAttribute("aria-pressed", String(tile.dataset.kind === pets.kind));
    drawPet(tile.querySelector("canvas"), tile.dataset.kind, "working", 0, true);
  }
}

/* ---------- the achievements' card ---------- */
function achievementsCard() {
  const box = card("delight-ach-card", "delight.ach.title", "Achievements", "delight.ach.note",
    "505 little milestones, only for you: Bronze, Silver, Gold, Diamond and Godly, a hundred of each, and five that are close to impossible. They are worked out on this computer from what really happens and are never sent anywhere. A streak only ever pauses.");
  const more = part("delight-ach-more"), line = el("div", "delight-ach-line"), all = el("button", "secondary", say("delight.ach.all", "See them all"));
  all.type = "button";
  all.addEventListener("click", () => void openSheet());
  line.append(Object.assign(el("span", "delight-ach-count"), { id: "delight-ach-count" }), all);
  const tries = el("div", "delight-tries");
  tries.append(el("span", "", say("delight.ach.try", "Try a celebration:")));
  for (const tier of TIERS) {
    const b = el("button", "secondary", say(`delight.ach.tier.t-${tier.replace("+", "p").toLowerCase()}`, tier));
    b.type = "button";
    b.addEventListener("click", () => preview(tier));
    tries.append(b);
  }
  more.append(line,
    checkRow("delight-ach-quiet", "delight.ach.quiet", "Quiet: earn them without any pop-up", (v) => saveDelight({ achievements: { quiet: v } })), tries);
  box.append(checkRow("delight-ach-on", "delight.ach.on", "Show achievements", (v) => saveDelight({ achievements: { on: v } })), more);
  return box;
}
function paintAchievementsCard() {
  const ach = state.settings?.achievements;
  if (!ach) return;
  $("delight-ach-on").checked = ach.on;
  $("delight-ach-quiet").checked = ach.quiet;
  $("delight-ach-more").hidden = !ach.on;
  $("delight-ach-count").textContent = say("delight.ach.soFar", "{earned} of 505 so far · rank {rank}", { earned: state.earned, rank: state.rank });
}
document.addEventListener("branch-achievements", () => paintAchievementsCard());

/* ---------- your own background's card ---------- */
function backgroundCard() {
  const box = card("delight-bg-card", "delight.bg.title", "Your own background", "delight.bg.note",
    "A picture, a video or an animation behind the glass instead of the oak. It stays in this window on this computer and is never sent anywhere.");
  const more = part("delight-bg-more"), pick = el("label", "delight-field delight-file"), file = el("input");
  file.type = "file";
  file.id = "delight-bg-file";
  file.accept = "image/png,image/jpeg,image/webp,image/gif,image/apng,image/avif,video/mp4,video/webm,.glb,model/gltf-binary";
  file.addEventListener("change", () => void pickFile(file));
  pick.append(el("span", "", say("delight.bg.choose", "Choose a file")), file);
  const limits = el("p", "field-note", say("delight.bg.limits3d", "Pictures and animations up to {picture} MB, videos up to {video} MB, 3D models (.glb) up to {model} MB.", { picture: LIMITS.picture, video: LIMITS.video, model: LIMITS["3d"] }));
  const chosen = el("div", "delight-ach-line"), forget = el("button", "secondary", say("delight.bg.remove", "Remove it"));
  forget.type = "button";
  forget.id = "delight-bg-remove";
  forget.addEventListener("click", () => void forgetBackground().then(paintBackgroundCard));
  chosen.append(Object.assign(el("span", "delight-bg-name"), { id: "delight-bg-name" }), forget);
  more.append(pick, limits, builtIns(), chosen, scrimRow(), fitRow(), statusLine("delight-bg-said"));
  box.append(checkRow("delight-bg-on", "delight.bg.on", "Use my own background", (v) => saveDelight({ background: { on: v } })), more);
  return box;
}
/** Branch's own 3D objects, for when there is no model file to hand. */
function builtIns() {
  const row = el("div", "delight-tries");
  row.append(el("span", "", say("delight.bg.orObject", "Or one of Branch's own 3D objects:")));
  for (const [model, key, english] of [["acorn", "delight.bg.model.acorn", "The acorn, in 3D"], ["oak", "delight.bg.model.oak", "The oak, in 3D"]]) {
    const b = el("button", "secondary", say(key, english));
    b.type = "button";
    b.dataset.model = model;
    b.addEventListener("click", () => void pickBuiltIn(model));
    row.append(b);
  }
  return row;
}
async function pickBuiltIn(model) {
  await chooseBuiltIn(model);
  if (!on("background")) await saveDelight({ background: { on: true } });
  $("delight-bg-said").textContent = say("delight.bg.kept", "Kept on this computer. It is behind the glass now.");
  await paintBackgroundCard();
}
function scrimRow() {
  const row = el("label", "delight-field"), range = el("input");
  range.type = "range";
  range.id = "delight-bg-scrim";
  Object.assign(range, { min: "20", max: "90", step: "5" });
  range.addEventListener("change", () => void saveDelight({ background: { scrim: Number(range.value) } }));
  row.append(el("span", "", say("delight.bg.scrim", "How much the theme's colour covers it (more keeps text easier to read)")), range);
  return row;
}
function fitRow() {
  const row = el("label", "delight-field"), select = el("select");
  select.id = "delight-bg-fit";
  for (const [value, key, english] of [["fill", "delight.bg.fill", "Fill the window"], ["fit", "delight.bg.fit", "Show all of it"], ["tile", "delight.bg.tile", "Repeat it"]])
    select.append(Object.assign(el("option", "", say(key, english)), { value }));
  select.addEventListener("change", () => void saveDelight({ background: { fit: select.value } }));
  row.append(el("span", "", say("delight.bg.fitLabel", "How it fits")), select);
  return row;
}
async function pickFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const answer = await chooseBackground(file).catch((error) => ({ ok: false, why: error.message }));
  input.value = "";
  $("delight-bg-said").textContent = answer.ok ? say("delight.bg.kept", "Kept on this computer. It is behind the glass now.") : answer.why;
  if (answer.ok && !on("background")) await saveDelight({ background: { on: true } });
  await paintBackgroundCard();
}
async function paintBackgroundCard() {
  const bg = state.settings?.background;
  if (!bg) return;
  $("delight-bg-on").checked = bg.on;
  $("delight-bg-scrim").value = String(bg.scrim);
  $("delight-bg-fit").value = bg.fit;
  const saved = await savedBackground();
  $("delight-bg-name").textContent = saved ? saved.name : say("delight.bg.none", "No file chosen yet.");
  $("delight-bg-remove").hidden = !saved;
}

/* ---------- putting the cards in place ---------- */
function buildCards() {
  if ($("delight-pet-card")) return;
  const cards = [petCard(), achievementsCard(), backgroundCard()];
  const host = $("lx-page-appearance") ?? document.body;
  for (const box of cards) { box.hidden = true; host.append(box); }
}
function paintCards() {
  buildCards();
  for (const id of ["delight-pet-card", "delight-ach-card", "delight-bg-card"]) $(id).hidden = !state.available;
  if (!state.available) return;
  paintPetCard();
  paintAchievementsCard();
  void paintBackgroundCard();
}
onDelight(paintCards);
/* The cards are drawn in the language of the moment; a new language draws them again. */
document.addEventListener("branch-language", () => {
  for (const id of ["delight-pet-card", "delight-ach-card", "delight-bg-card"]) $(id)?.remove();
  paintCards();
});

/* ---------- the acorn in 3D ---------- */
let acorn3d = null;
const acornStill = () => still() || root.dataset.acorn !== "on" || $("acorn-motion")?.dataset.paused === "true";
function applyStyle() {
  const want = state.available && state.settings?.look?.style === "3d", art = document.querySelector("#delight-corner .acorn-art");
  if (!want || !art) {
    acorn3d?.stop();
    acorn3d = null;
    $("acorn-3d")?.remove();
    delete root.dataset.delightStyle;
    return;
  }
  if ($("acorn-3d")) return;
  const canvas = el("canvas", "acorn-3d");
  canvas.id = "acorn-3d";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", say("delight.look.acorn", "The acorn, in 3D. Drag to turn it."));
  canvas.title = say("acorn.tip", "Drag to turn");
  art.prepend(canvas);
  acorn3d = view3d(canvas, acornModel(), { distance: 2.7, still: acornStill });
  if (!acorn3d) { canvas.remove(); return; }
  root.dataset.delightStyle = "3d";
}
onDelight(applyStyle);
new MutationObserver(() => acorn3d?.start()).observe(root, { attributes: true, attributeFilter: ["data-acorn", "data-motion"] });
new MutationObserver(() => acorn3d?.setParts(acornModel())).observe(root, { attributes: true, attributeFilter: ["data-palette", "data-theme"] });
const pause = $("acorn-motion");
if (pause) new MutationObserver(() => acorn3d?.start()).observe(pause, { attributes: true, attributeFilter: ["data-paused"] });

/* ---------- what the window really saw, while achievements are on ---------- */
let lastLook = "";
function noticeLook() {
  if (!on("achievements") || !root.dataset.palette) return;
  const mode = root.dataset.theme === "daylight" ? "light" : "dark";
  let season = seasonToday();
  try { season = localStorage.getItem("branch-season") || season; } catch { /* the season of today, then */ }
  if (!["spring", "summer", "autumn", "winter"].includes(season)) season = seasonToday();
  const key = `${mode}:${root.dataset.palette}:${season}`;
  if (key === lastLook) return;
  lastLook = key;
  void notice({ what: "theme", mode, theme: root.dataset.palette, season });
  void notice({ what: "season", season });
}
function noticeFlags() {
  if (!on("achievements")) return;
  if (root.dataset.acorn === "on") void notice({ what: "flag", flag: "acorn-shown" });
  if (root.dataset.motion === "reduced") void notice({ what: "flag", flag: "still" });
  if (root.dataset.everything === "on") void notice({ what: "flag", flag: "everything" });
}
new MutationObserver(() => { noticeLook(); noticeFlags(); })
  .observe(root, { attributes: true, attributeFilter: ["data-palette", "data-theme", "data-acorn", "data-motion", "data-everything"] });
document.addEventListener("branch-language", (event) => { if (event.detail?.language && event.detail.language !== "en") void notice({ what: "flag", flag: "language" }); });
document.addEventListener("click", (event) => {
  const page = event.target.closest?.(".lx-settings-link")?.dataset.page;
  if (page) void notice({ what: "page", page });
});
let turned = false;
$("keepoak-acorn")?.addEventListener("pointermove", (event) => {
  if (turned || !event.buttons) return;
  turned = true;
  void notice({ what: "flag", flag: "acorn-turned" });
});
/* A hook for "hide anything": when everything that can be hidden is hidden, that part of the window
   says so with this event, and "It's lonely over here" is earned. */
document.addEventListener("branch-everything-hidden", () => void notice({ what: "flag", flag: "lonely" }));
onDelight(() => { lastLook = ""; noticeLook(); noticeFlags(); });

/* ---------- starting ---------- */
const workspace = $("workspace");
if (workspace) new MutationObserver(() => { if (workspace.hidden === false) void loadDelight(); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
document.addEventListener("branch-profile", () => void loadDelight());
buildCards();
void loadDelight();
globalThis.branchDelight = {
  reload: loadDelight,
  openSettings() {
    displayView("settings:appearance");
    requestAnimationFrame(() => $("delight-pet-card")?.scrollIntoView({ block: "start" }));
  },
};
