/* phase2/shell: the Add a Trunk studio (kept as the owner loved it, critique #34) and changing a
   Trunk after it is made (critiques #7, #8).

   One dialog with one tab strip — A new Trunk, Another computer, Your phone — that stays put while
   you move between them, each pairing step with a Back. A Trunk's look is its face (drawn from the
   name, letters, an emoji, a photo, or pixel art), its colour (one of the theme's eight, or the
   theme's own highlight), its shape and how it moves, with a live preview of it in the strip and on
   its replies. Pairing lives in public/pairing.js. Words have data-t keys; no colour is written here. */
import { api, toast } from "/app.js";
import { face, initialsOf, MOTIONS, TRUNK_SHAPES, maskOf, trunkColour, trunkSpec } from "/faces.js";
import { findTrunk, icon, make, openTrunk, refresh, say, shell, showOverview, trunksOn } from "/strip.js";

const $ = (id) => document.getElementById(id);
const EMOJI = [["🌳", "tree oak"], ["🌰", "acorn nut"], ["🍂", "leaves autumn"], ["🌿", "herb plant"], ["🌱", "seedling sprout"], ["🍄", "mushroom"],
  ["🌸", "blossom flower spring"], ["🦉", "owl wise night"], ["🦊", "fox"], ["🐿️", "squirrel"], ["🦔", "hedgehog"], ["🐝", "bee busy"], ["🐢", "turtle slow"],
  ["🦫", "beaver builder"], ["📒", "ledger notebook books"], ["🧾", "receipt"], ["💼", "briefcase work"], ["📊", "chart numbers"], ["🧮", "abacus count"],
  ["🔎", "search look"], ["🧭", "compass guide"], ["🗺️", "map travel"], ["📬", "mail post"], ["📅", "calendar date"], ["⏰", "alarm clock time"],
  ["🛒", "cart shopping"], ["🍳", "cooking kitchen"], ["🏡", "home house"], ["☕", "coffee"], ["🎧", "music headphones"], ["🎨", "art paint"],
  ["📚", "books reading"], ["✍️", "writing"], ["🧪", "lab test"], ["🛠️", "tools fix"], ["🤖", "robot"], ["🛡️", "shield safe"], ["🔑", "key"],
  ["⚡", "energy fast"], ["🌙", "moon night"], ["☀️", "sun day"], ["❄️", "snow winter"]];
const FACES = [["drawn", "studio.face.drawn", "Drawn face"], ["letters", "studio.face.letters", "Letters"], ["emoji", "studio.face.emoji", "Emoji"],
  ["photo", "studio.face.photo", "Photo"], ["pattern", "studio.face.pattern", "Pixel pattern"]];
const SHAPE_WORDS = { circle: "Circle", squircle: "Soft square", leaf: "Leaf", acorn: "Acorn", shield: "Shield", hexagon: "Hexagon", pebble: "Pebble" };
const MOTION_WORDS = { none: "None", breathe: "Breathe", sway: "Sway like a leaf", shimmer: "Shimmer", pulse: "Pulse while working", dots: "Dots while working" };
export const TABS = [["trunk", "studio.tab.trunk", "A new Trunk"], ["computer", "studio.tab.computer", "Another computer"], ["phone", "studio.tab.phone", "Your phone"]];
const photoLimit = 290_000;
/* DG-105: the approved sample's colours, in its order, read from the token layer (`--trunk-colour-1` to 20 in
   public/tokens.css), then any other colour from the picker. A chosen colour is saved as the value it is. */
const palette = () => Array.from({ length: 20 }, (_, at) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--trunk-colour-${at + 1}`).trim()).filter(Boolean);
const isHex = (colour) => /^#[0-9a-f]{6}$/i.test(String(colour ?? ""));

/* ---------- the dialog ---------- */
export const studio = { dialog: null, tab: "trunk", draft: null, editing: null, closing: null };
function button(className, key, english, handler, values) {
  const node = make("button", /glass-option/.test(className) ? className : `shell-btn ${className}`.trim(), key, english, values);
  node.type = "button";
  if (handler) node.addEventListener("click", () => void Promise.resolve(handler()).catch((error) => toast(error.message ?? String(error))));
  return node;
}
export { button };
/** Opens the dialog with a title. `studio.closing(proceed)` may keep it open (and call `proceed` later). */
export function openDialog(key, english, values) {
  closeDialog(true);
  const dialog = make("dialog", "studio-dlg");
  dialog.id = "studio";
  const head = make("div", "studio-head");
  const title = make("h2", "studio-title", key, english, values);
  title.id = "studio-title";
  dialog.setAttribute("aria-labelledby", "studio-title");
  const close = button("studio-x", null, null, () => closeDialog());
  close.setAttribute("aria-label", say("studio.close", "Close"));
  close.append(icon("close"));
  head.append(title, close);
  const body = make("div", "studio-body");
  body.id = "studio-body";
  dialog.append(head, body);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  document.body.append(dialog);
  dialog.showModal();
  studio.dialog = dialog;
  return body;
}
/** Closes the dialog; while an invitation is open it asks first, unless `force`. */
export function closeDialog(force = false) {
  if (!studio.dialog) return;
  if (!force && studio.closing && studio.closing(() => closeDialog(true)) === false) return;
  studio.closing = null;
  studio.dialog.close();
  studio.dialog.remove();
  studio.dialog = null;
  document.dispatchEvent(new CustomEvent("branch-studio-closed"));
}
function tabStrip() {
  const strip = make("div", "studio-tabs");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", say("studio.tabs", "What to add"));
  for (const [id, key, english] of TABS) {
    const tab = button("studio-tab", key, english, () => showTab(id));
    tab.setAttribute("role", "tab");
    tab.dataset.tab = id;
    tab.setAttribute("aria-selected", String(studio.tab === id));
    strip.append(tab);
  }
  return strip;
}
/** The tab strip stays; only what is under it changes (critique #34). */
export async function showTab(id, keep = false) {
  const body = $("studio-body");
  if (!body) return;
  if (studio.tab !== id && studio.closing && studio.closing(() => { studio.closing = null; void showTab(id); }) === false) return;
  studio.closing = null;
  studio.tab = id;
  const panel = make("div", "studio-panel");
  panel.setAttribute("role", "tabpanel");
  body.replaceChildren(tabStrip(), panel);
  if (id === "trunk") return trunkPanel(panel);
  const pairing = await import("/pairing.js");
  return id === "computer" ? pairing.computerPanel(panel, keep) : pairing.phonePanel(panel, keep);
}
/** A computer or phone asking to join, picked in the strip: straight to Let it in. */
export async function openLetIn(request) {
  const phone = request.platform === "ios" || request.platform === "android";
  const pairing = await import("/pairing.js");
  pairing.askingFrom(request, phone ? "phone" : "computer");
  studio.editing = null;
  studio.draft = newDraft();
  openDialog("studio.title.add", "Add a Trunk");
  studio.tab = phone ? "phone" : "computer";
  await showTab(studio.tab, true);
}
/** + in the strip: the studio on the tab asked for. */
export function openAdd(tab = "trunk") {
  studio.editing = null;
  studio.draft = newDraft();
  openDialog("studio.title.add", "Add a Trunk");
  void showTab(tab);
}

/* ---------- a Trunk's look: the draft ---------- */
function newDraft() {
  return { name: "", title: "", pinned: true,
    look: { face: "pattern", letters: "", emoji: "🌱", shuffle: 0, colour: palette()[0], shape: "leaf", motion: "breathe", depth: "flat" }, photo: null, keptPhoto: null };
}
function draftTrunk() {
  const d = studio.draft;
  const photo = d.look.face === "photo" ? d.photo ?? d.keptPhoto : null;
  return { name: d.name || say("studio.newName", "New Trunk"), look: { ...d.look, face: d.look.face === "photo" ? "drawn" : d.look.face },
    avatar: photo ? { kind: "image", dataUrl: photo } : { kind: "face", seed: d.name } };
}

/* ---------- the Trunk tab ---------- */
async function trunkPanel(panel) {
  if (!studio.editing && !trunksOn()) return panel.append(trunksOffCard(panel));
  const grid = make("div", "studio-grid");
  const form = make("div", "studio-form");
  form.id = "studio-form";
  const preview = make("div", "studio-preview");
  preview.id = "studio-preview";
  grid.append(form, preview);
  panel.append(grid, footer());
  drawForm();
  drawPreview();
}
function trunksOffCard(panel) {
  const card = make("div", "studio-off");
  card.append(make("p", "studio-lede", "studio.off.lede", "Trunks are switched off."),
    make("p", "studio-note", "studio.off.note", "A Trunk is an assistant of your own: its own name, face and conversation. Everything it may reach — chat apps, commands, tool servers — starts off."),
    button("studio-primary", "studio.off.on", "Switch Trunks on", async () => {
      await api("trunks/switch", { part: "trunks", mode: "on" });
      await refresh();
      panel.replaceChildren();
      await trunkPanel(panel);
    }));
  return card;
}
function section(key, english) {
  const node = make("section", "studio-section");
  node.append(make("h3", "", key, english));
  return node;
}
function field(key, english, value, onInput, id, hint) {
  const label = make("label", "studio-field");
  const input = document.createElement("input");
  input.id = id;
  input.value = value;
  if (hint) { input.placeholder = say(...hint); input.dataset.tPlaceholder = hint[0]; }
  input.autocomplete = "off";
  input.addEventListener("input", () => onInput(input.value));
  label.append(make("span", "", key, english), input);
  return label;
}
function segmented(options, current, onPick, label) {
  const group = make("div", "studio-seg");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const [value, key, english] of options) {
    const choice = button("", key, english, () => onPick(value));
    choice.setAttribute("aria-pressed", String(current === value));
    group.append(choice);
  }
  return group;
}
function drawForm() {
  const form = $("studio-form"), d = studio.draft;
  if (!form) return;
  const who = section("studio.who", "Who it is");
  who.append(field("studio.name", "Name", d.name, (value) => { d.name = value; drawPreview(); }, "studio-name", ["studio.name.hint", "For example: Gardener"]),
    field("studio.what", "What it does, in a few words", d.title, (value) => { d.title = value; }, "studio-what", ["studio.what.hint", "For example: plans the vegetable beds and the watering"]));
  form.replaceChildren(who, faceSection(), colourSection(), shapeSection(), motionSection(), depthSection(), ...(studio.editing ? [pinSection()] : []));
}
function redraw() { drawForm(); drawPreview(); }
function faceSection() {
  const d = studio.draft, part = section("studio.face", "Face");
  part.append(segmented(FACES, d.look.face, (value) => { d.look.face = value; redraw(); }, say("studio.face", "Face")));
  const body = make("div", "studio-face-body");
  if (d.look.face === "letters") body.append(field("studio.letters", "Letters (one or two)", d.look.letters || initialsOf(d.name), (value) => { d.look.letters = value.slice(0, 2).toUpperCase(); drawPreview(); }, "studio-letters"));
  if (d.look.face === "emoji") body.append(emojiPicker());
  if (d.look.face === "photo") body.append(photoPicker());
  if (d.look.face === "pattern") body.append(button("", "studio.shuffle", "Shuffle", () => { d.look.shuffle = (d.look.shuffle + 1 + Math.floor(Math.random() * 997)) % 999999; drawPreview(); }),
    make("span", "studio-note", "studio.pattern.note", "Pixel art made from the name, dithered like the acorn."));
  if (d.look.face === "drawn") body.append(make("span", "studio-note", "studio.drawn.note", "Two eyes and a smile made from the name. A new name makes a new face."));
  part.append(body);
  return part;
}
function emojiPicker() {
  const d = studio.draft, wrap = make("div", "studio-emoji");
  const search = document.createElement("input");
  search.type = "search";
  search.id = "studio-emoji-search";
  search.placeholder = say("studio.emoji.search", "Search emoji: owl, receipt, leaf…");
  search.dataset.tPlaceholder = "studio.emoji.search";
  search.setAttribute("aria-label", say("studio.emoji.search", "Search emoji: owl, receipt, leaf…"));
  const grid = make("div", "studio-emoji-grid");
  const fill = () => {
    const words = search.value.trim().toLowerCase();
    grid.replaceChildren(...EMOJI.filter(([, names]) => !words || names.includes(words)).map(([emoji]) => {
      const pick = button("studio-emoji-pick", null, null, () => { d.look.emoji = emoji; fill(); drawPreview(); });
      pick.dataset.emoji = emoji;
      pick.setAttribute("aria-label", emoji);
      pick.setAttribute("aria-pressed", String(d.look.emoji === emoji));
      const glyph = make("span", "fc-emoji");
      glyph.dataset.text = emoji;
      pick.append(glyph);
      return pick;
    }));
    if (!grid.children.length) grid.append(make("p", "studio-note", "studio.emoji.none", "No emoji by that word."));
  };
  search.addEventListener("input", fill);
  fill();
  wrap.append(search, grid);
  return wrap;
}
function photoPicker() {
  const d = studio.draft, wrap = make("div", "studio-photo");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.id = "studio-photo-file";
  input.hidden = true;
  const choose = make("label", "studio-button", d.photo || d.keptPhoto ? "studio.photo.other" : "studio.photo.choose", d.photo || d.keptPhoto ? "Choose another photo" : "Choose a photo");
  choose.htmlFor = input.id;
  input.addEventListener("change", () => readPhoto(input.files?.[0]));
  wrap.append(input, choose, make("span", "studio-note", "studio.photo.note", "A PNG, JPEG or WebP under about 290 KB. It is kept on this computer with the Trunk."));
  return wrap;
}
function readPhoto(file) {
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return toast(say("studio.photo.kind", "Choose a PNG, JPEG or WebP picture."));
  const reader = new FileReader();
  reader.onload = () => {
    if (String(reader.result).length > photoLimit * 1.37) return toast(say("studio.photo.large", "That picture is too large. Choose one under about 290 KB."));
    studio.draft.photo = String(reader.result);
    redraw();
  };
  reader.readAsDataURL(file);
}
function colourSection() {
  const d = studio.draft, part = section("studio.colour", "Colour");
  const row = make("div", "studio-swatches");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", say("studio.colour", "Colour"));
  const chosen = String(d.look.colour).toLowerCase();
  for (const colour of palette()) {
    const swatch = button("studio-swatch", null, null, () => { d.look.colour = colour; redraw(); });
    swatch.style.setProperty("--c", colour);
    swatch.dataset.colour = colour;
    swatch.setAttribute("aria-label", say("studio.colour.n", "Colour {n}", { n: colour }));
    swatch.setAttribute("aria-pressed", String(chosen === colour.toLowerCase()));
    row.append(swatch);
  }
  /* Any colour: the sample's rainbow circle with a + over the system's colour picker. */
  const custom = make("label", "studio-swatch studio-swatch-custom");
  const picker = document.createElement("input");
  picker.type = "color";
  picker.id = "studio-custom";
  picker.value = isHex(d.look.colour) ? chosen : palette()[0].toLowerCase();
  picker.setAttribute("aria-label", say("studio.colour.custom", "Any colour"));
  custom.title = picker.getAttribute("aria-label");
  picker.addEventListener("input", () => {
    d.look.colour = picker.value;
    for (const swatch of row.querySelectorAll(".studio-swatch[aria-pressed]")) swatch.setAttribute("aria-pressed", "false");
    const follow = $("studio-follow");
    if (follow) follow.checked = false;
    drawPreview();
  });
  custom.append(picker, Object.assign(document.createElement("span"), { textContent: "+", ariaHidden: "true" }));
  row.append(custom);
  /* DG-106: the sample's switch row (a `.ctl` holding `.sw`): the words, the switch beside them, the note beneath. */
  const follow = make("label", "studio-follow");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "studio-follow";
  box.className = "sw";
  box.setAttribute("role", "switch");
  box.checked = d.look.colour === "theme";
  /* Off again, it keeps the colour it had before following, as the sample's does. */
  box.addEventListener("change", () => {
    if (box.checked && d.look.colour !== "theme") d.lastColour = d.look.colour;
    d.look.colour = box.checked ? "theme" : d.lastColour ?? palette()[0];
    redraw();
  });
  follow.append(make("span", "studio-follow-words", "studio.follow", "Follow my theme"), box,
    make("span", "studio-follow-note", "studio.follow.note", "Takes the highlight colour of whichever theme is on."));
  part.append(row, follow);
  return part;
}
function shapeSection() {
  const d = studio.draft, part = section("studio.shape", "Shape");
  const grid = make("div", "studio-shapes");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", say("studio.shape", "Shape"));
  for (const shape of TRUNK_SHAPES) {
    const pick = button("studio-shape", null, null, () => { d.look.shape = shape; redraw(); });
    const mark = document.createElement("i");
    mark.style.setProperty("--m", maskOf(shape));
    pick.append(mark, make("span", "", `studio.shape.${shape}`, SHAPE_WORDS[shape]));
    pick.setAttribute("aria-pressed", String(d.look.shape === shape));
    grid.append(pick);
  }
  part.append(grid);
  return part;
}
function motionSection() {
  const d = studio.draft, part = section("studio.motion", "Movement");
  part.append(segmented(MOTIONS.map((motion) => [motion, `studio.motion.${motion}`, MOTION_WORDS[motion]]), d.look.motion,
    (value) => { d.look.motion = value; redraw(); }, say("studio.motion", "Movement")),
  make("p", "studio-note", "studio.motion.note", "Pulse and Dots only move while it works. Your computer's reduce-motion setting stops all of it."));
  return part;
}
function depthSection() {
  const d = studio.draft, part = section("studio.depth", "Style");
  part.append(segmented([["flat", "studio.depth.flat", "Flat"], ["3d", "studio.depth.3d", "3D stand-in"]], d.look.depth,
    (value) => { d.look.depth = value; redraw(); }, say("studio.depth", "Style")));
  const on = shell.look.faces3d === "on";
  part.append(make("p", "studio-note", on ? "studio.depth.on" : "studio.depth.off",
    on ? "A thick tile that turns slowly. Real 3D models come later; flat is one click away." : "3D faces are switched off in Settings › Appearance, so it shows flat until you switch them on."));
  return part;
}
function pinSection() {
  const d = studio.draft, part = section("studio.place", "Where it sits");
  const label = make("label", "studio-check");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "studio-pinned";
  box.checked = d.pinned;
  box.addEventListener("change", () => { d.pinned = box.checked; });
  label.append(box, make("span", "", "studio.pinned", "Pin it to the top of the strip and the sidebar"));
  part.append(label);
  return part;
}
function drawPreview() {
  const host = $("studio-preview");
  if (!host) return;
  const spec = trunkSpec(draftTrunk());
  const big = make("div", "studio-big");
  big.append(face(spec, 104, { status: "on", ground: "strip" }));
  const strip = make("div", "studio-strip-row");
  // Integration review: each face says its own state underneath, so the words never wrap into a column of dots.
  const states = [["on", "strip.status.on", "Ready"], ["wait", "strip.status.wait", "Needs you"], ["off", "strip.status.off", "Off"]];
  strip.append(...states.map(([status, key, english]) => {
    const one = make("span", "studio-state");
    one.append(face(spec, 42, { status, ground: "strip" }), make("span", "", key, english));
    return one;
  }));
  const reply = make("div", "studio-reply");
  const words = make("div", "studio-reply-words");
  words.append(Object.assign(make("small"), { textContent: studio.draft.name || say("studio.newName", "New Trunk") }), make("i"), make("i", "short"));
  reply.append(face(spec, 24, { flat: true }), words);
  host.replaceChildren(big, make("p", "studio-h", "studio.preview.strip", "In the strip"), strip, make("p", "studio-h", "studio.preview.reply", "On its replies"), reply);
}
function footer() {
  const foot = make("div", "studio-foot");
  if (!studio.editing) foot.append(make("span", "studio-note", "studio.foot.note", "It introduces itself in its own conversation. Everything else can be changed later."));
  foot.append(make("span", "grow"), button("", "studio.cancel", "Cancel", () => closeDialog()),
    studio.editing ? button("studio-primary", "studio.save", "Save", saveEdit) : button("studio-primary", "studio.create", "Create the Trunk", createTrunk));
  return foot;
}

/* ---------- saving ---------- */
/* DG-105: a colour picked as a value is saved as the Trunk's chosenColour, with the look's own colour left
   empty, so a build from before it still reads the look; a token or "theme" clears the picked colour. */
function lookToSave() {
  const look = { ...studio.draft.look };
  if (look.face === "photo") look.face = "drawn";
  if (look.face !== "letters") look.letters = "";
  if (isHex(look.colour)) look.colour = null;
  return look;
}
const colourToSave = () => (isHex(studio.draft.look.colour) ? studio.draft.look.colour.toLowerCase() : null);
async function savePhoto(id) {
  const d = studio.draft;
  if (d.look.face === "photo" && d.photo) return api(`trunks/${id}/avatar`, { kind: "image", dataUrl: d.photo });
  if (d.look.face !== "photo" && d.keptPhoto) return api(`trunks/${id}/avatar`, { kind: "face", locked: false });
  return null;
}
async function createTrunk() {
  const d = studio.draft, name = d.name.trim();
  if (!name) return $("studio-name")?.focus();
  const { trunk } = await api("trunks", { name, title: d.title.trim(), description: "" });
  await api(`trunks/${trunk.id}`, { look: lookToSave(), chosenColour: colourToSave(), pinned: d.pinned });
  await savePhoto(trunk.id);
  closeDialog(true);
  await refresh();
  const fresh = findTrunk(trunk.id);
  if (fresh) await openTrunk(fresh);
  document.querySelector(`#trunk-strip [data-strip-id="trunk:${trunk.id}"]`)?.classList.add("fresh");
  toast(say("studio.created", "{name} introduces itself in its own conversation.", { name }));
}
async function saveEdit() {
  const d = studio.draft, id = studio.editing, name = d.name.trim();
  if (!name) return $("studio-name")?.focus();
  await api(`trunks/${id}`, { name, title: d.title.trim(), look: lookToSave(), chosenColour: colourToSave(), pinned: d.pinned });
  await savePhoto(id);
  closeDialog(true);
  await refresh();
  toast(say("studio.saved", "Saved."));
}

/** Change look… and Rename… from the strip's menu, Customize › Specialists or the Overview. */
export async function openEdit(id, { rename = false } = {}) {
  await refresh();
  const trunk = findTrunk(id);
  if (!trunk) return toast(say("studio.gone", "That Trunk is no longer here."));
  const look = { face: "drawn", letters: "", emoji: "🌱", shuffle: 0, colour: null, shape: null, motion: "none", depth: "flat", ...(trunk.look ?? {}) };
  const spec = trunkSpec(trunk);
  if (look.colour === null) look.colour = trunkColour(trunk) ?? Number(/series-(\d)/.exec(spec.colour)?.[1] ?? 1);
  if (look.shape === null) look.shape = spec.shape;
  const photo = trunk.avatar && trunk.avatar.kind !== "face" ? trunk.avatar.dataUrl : null;
  if (photo) look.face = "photo";
  studio.editing = id;
  studio.draft = { name: trunk.name, title: trunk.title, pinned: trunk.pinned, look, photo: null, keptPhoto: photo };
  const body = openDialog("studio.title.edit", "Change {name}", { name: trunk.name });
  studio.tab = "trunk";
  const panel = make("div", "studio-panel");
  body.append(panel);
  await trunkPanel(panel);
  if (rename) { $("studio-name")?.focus(); $("studio-name")?.select(); }
}

/* ---------- a change of language ----------
   Words with a data-t key follow by themselves; sentences with a name in them are drawn again. */
document.addEventListener("branch-language", () => {
  if (!studio.dialog) return;
  const title = $("studio-title");
  if (title?.dataset.tTemplate && studio.editing) title.textContent = say(title.dataset.tTemplate, "Change {name}", { name: studio.draft.name });
  if (studio.tab === "trunk" || studio.editing) { drawForm(); drawPreview(); }
  else void import("/pairing.js").then((pairing) => pairing.relabelPairing());
});

/* ---------- small questions: remove, rename a computer ---------- */
function ask(key, english, values, words, actions) {
  const body = openDialog(key, english, values);
  body.classList.add("studio-small");
  const foot = make("div", "studio-foot");
  foot.append(make("span", "grow"), ...actions);
  body.append(...words, foot);
  return body;
}
export function confirmRemoveTrunk(trunk) {
  ask("studio.remove.title", "Remove {name}?", { name: trunk.name },
    [make("p", "", "studio.remove.words", "Its conversations stay in your history. Its routines stop, and it leaves any room it is in.")],
    [button("", "studio.keep", "Keep it", () => closeDialog(true)), button("studio-danger", "studio.remove", "Remove", async () => {
      await api(`trunks/${trunk.id}/remove`, {});
      closeDialog(true);
      await refresh();
      toast(say("studio.removed", "Removed {name}. Its conversations stay in your history.", { name: trunk.name }));
    })]);
}
export function confirmRemoveDevice(device) {
  ask("studio.removeDevice.title", "Remove {name}?", { name: device.name },
    [make("p", "", "studio.removeDevice.words", "It will no longer lend Branch anything, and it has to be paired again to come back.")],
    [button("", "studio.keep", "Keep it", () => closeDialog(true)), button("studio-danger", "studio.remove", "Remove", async () => {
      await api(`devices/${device.id}/revoke`, {});
      closeDialog(true);
      await refresh();
      showOverview("here");
      toast(say("studio.removedDevice", "Removed {name}.", { name: device.name }));
    })]);
}
/** Rename a computer (critique #27): its own name stays underneath as what it is. */
export function renameDevice(device) {
  const input = document.createElement("input");
  input.id = "studio-device-name";
  input.value = device.name;
  input.maxLength = 80;
  input.autocomplete = "off";
  const label = make("label", "studio-field");
  label.append(make("span", "", "studio.name", "Name"), input);
  const save = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    await api(`devices/${device.id}/rename`, { name });
    closeDialog(true);
    await refresh();
    toast(say("studio.renamed", "Renamed to {name}.", { name }));
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") void save(); });
  ask("studio.rename.title", "Rename {name}", { name: device.name }, [label], [button("", "studio.cancel", "Cancel", () => closeDialog(true)), button("studio-primary", "studio.save", "Save", save)]);
  input.focus();
  input.select();
}
