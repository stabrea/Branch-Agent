/* Settings › Appearance, 1:1 with the prototype's page, from the engine: light or dark and the reading choices from the
   preferences (POST /api/preferences replaces the whole record, so shell/look.js lays each change over it), the theme
   from GET /api/look (the gallery and the colour editor are shell/themes.js), the background and the pet from the
   engine's delight switches (shell/scene.js). The painted scene, its season and where the pet walks are this window's.
   Your own background's file stays in this window's storage (shell/ownbg.js); the engine keeps how it fits. */

import { E, S, refresh } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { ic, toast, openDlg, closeDlg } from "../../core/ui.js";
import { L, lookOf, lookEF, wornId, effMode, more, swatch, looks, savePrefs } from "../../shell/look.js";
import { ACCENTS } from "../../shell/themes.js";
import { D, W, SCENES, loadDelight, saveDelight, saveWindow, showsBackground, bgChoice, drawBackground } from "../../shell/scene.js";
import { OWN, LIMITS, kindOf, keep, forget } from "../../shell/ownbg.js";
import { appearance17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { ART17, PETS17, pet17, art17Slot } from "../../core/art17.js";
import { sec17 } from "../rows17.js";
import { AG, saveUi } from "../../chat/agent17.js";

const pressed = (on) => `aria-pressed="${!!on}"`;
const segAct = (title, sub, opts, cur, act) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l, a]) => `<button type="button" ${pressed(v === cur)} data-act="${a ?? act}" data-v="${v}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;
const prefs = () => E.state?.preferences ?? {};

/* The light and dark previews mirror the conversation that is open (its title and last line). */
const current = () => E.sessions.find((s) => (s.sessionId ?? s.id) === S.chat) ?? E.sessions[0];
function mirror(mode) {
  const c = mode === "light"
    ? { bg: "#F8FAFB", side: "#EFF3F5", u: "#7A8791", bub: "#E6ECEF", ink: "#16212A", edge: "#C9D3D9" }
    : { bg: "#11161A", side: "#0C1013", u: "#7D8A93", bub: "#1A2228", ink: "#E8EEF2", edge: "#2D3840" };
  const rows = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A"].map((d) => `<span class="mm-r"><i data-css="background:${d}"></i><u data-css="background:${c.u};opacity:.5"></u></span>`).join("");
  const s = current(), name = s?.opening || E.state?.identity?.name || "";
  return `<button class="mirror" type="button" data-act="themeset" data-v="${mode}" ${pressed(document.documentElement.dataset.theme === mode)}><span class="mm" data-css="background:${c.bg}"><span class="mm-s" data-css="background:${c.side}">${rows}</span><span class="mm-m"><span><span class="mm-b" data-css="background:${c.bub};color:${c.ink};display:block">${esc(s?.opening ?? "")}</span><span class="mm-t" data-css="color:${c.ink};display:block">${esc((s?.lastMessage ?? "").slice(0, 90))}</span></span><span class="mm-c" data-css="border:1px solid ${c.edge}"><i data-css="background:#E07033"></i></span></span></span><b>${mode === "light" ? "Light" : "Dark"} · live mirror of ${esc(name)}</b></button>`;
}

function themeSection() {
  const id = wornId(), mode = effMode(), x = lookOf(id), eff = lookEF(id, mode);
  const accs = ACCENTS.map((a) => `<button type="button" class="acc" data-css="--c:${a}" data-act="acc-set" data-v="${a}" ${pressed(L.accent === a)} aria-label="Accent ${a}"></button>`).join("");
  const mine = L.my.length ? `<div class="ctl"><b>Your themes</b><span class="right acts" data-css="gap:6px;flex-wrap:wrap">${L.my.map((t) => `<button class="chip6" type="button" data-act="skin" data-v="my-${esc(t.id)}" ${pressed(id === "my-" + t.id)}>${esc(t.name)}</button>`).join("")}</span><small>Saved on this computer. Edit, copy or share them from Themes › Yours.</small></div>` : "";
  return `<div class="sec"><h2>Theme</h2><div class="theme-now">${swatch(eff)}<span class="grow"><b>${esc(x[1])}</b><small>${esc(x[3] ? "Yours" : x[2])} · ${mode === "dark" ? "Moonlight" : "Daylight"}${more() ? " · more contrast" : ""}</small><span class="acts"><button class="btn pri sm" type="button" data-act="skins">Browse all ${looks().length} themes</button><button class="btn sm" type="button" data-act="ce-new">${ic("palette", "s")}Make your own</button></span></span></div>
    <div class="ctl"><b>Accent colour</b><span class="right accs"><button type="button" class="acc theme-acc" data-act="acc-set" data-v="theme" ${pressed(!L.accent)} aria-label="The theme’s own accent">A</button>${accs}<label class="acc acc-pick" aria-label="Any colour"><input type="color" id="acc-pick" value="${L.accent || eff.accent}"></label></span><small>Only for what wants you: the working ring, the waiting dot, the yes button. <button class="link" type="button" data-act="acc-save">Save as a theme</button></small></div>
    <div class="ctl"><b>More contrast</b><input class="sw" type="checkbox" id="a-contrast" data-sw="contrast" aria-label="More contrast" ${more() ? "checked" : ""}><small>Stronger lines and text, from each theme’s own high-contrast colours.</small></div>${mine}</div>`;
}

/* The agent beside the conversation (chat/agent17.js): whether it shows and its size are this window's. */
function agentsSection() {
  return `<div class="sec"><h2>Agents</h2><div class="ctl"><b>Show the agent beside the conversation</b><input class="sw" type="checkbox" id="ag-show" aria-label="Show the agent beside the conversation" data-sw="set" ${AG.show ? "checked" : ""}><small>It acts out what the Trunk is doing: thinking, searching, reading, working, waiting for you, celebrating, resting.</small></div>${segAct("Size", "Small keeps it out of the way.", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], AG.size, "ag-size")}</div>`;
}

/* Pass 17 (Advanced): the pictures Branch uses where a feature starts or has nothing to show yet (core/art17.js). */
const picturesSection = (lv) => (lv < 1 ? "" : sec17("Pictures around Branch", `<div class="arts17e">${Object.entries(ART17).map(([id, [label]]) => `<figure class="art-c17e">${art17Slot(id)}<figcaption>${esc(label)}</figcaption></figure>`).join("")}</div>`,
  "Shown where a feature starts or has nothing to show yet. They move gently, and hold still when motion is reduced."));

/* Your own file: choosing one, or the one kept with its fit, Remove and a file to replace it (prototype pass 6). */
const KINDS = { picture: "Picture", animation: "Animation", video: "Video", "3d": "3D model" };
function ownRows() {
  const s = OWN.saved, file = (id, label) => `<input type="file" id="${id}" data-sw="bgfile" accept="image/*,video/*" aria-label="${label}">`;
  if (!s) return `<div class="ctl"><b>Choose a file</b><span class="right">${file("bg-file6", "Choose a background file")}</span><small>A picture or animation up to ${LIMITS.picture} MB, a video up to ${LIMITS.video} MB. Kept in this window only, never sent anywhere.</small></div>`;
  const fits = [["fill", "Fill"], ["fit", "Fit"], ...(s.kind === "video" ? [] : [["tile", "Tile"]])];
  return `<div class="ctl"><b>${esc(s.name)}</b><span class="right"><button class="btn sm" type="button" data-act="bg-remove">Remove</button></span><small>${KINDS[s.kind] ?? ""} · ${(s.size / 1048576).toFixed(1)} MB</small></div>
    ${s.kind !== "3d" ? segAct("Fit", "Tile is for pictures and animations.", fits, D.settings?.background?.fit ?? "fill", "bgfit") : ""}<div class="ctl"><b>Another file</b><span class="right">${file("bg-file6", "Choose another background file")}</span><small>Replaces this one.</small></div>`;
}

/* Pass 17's six scenes carry a small "New" mark, as the prototype's do. */
const NEW_SCENES17 = new Set(["night17-lake", "night17-highland", "day17-sea", "day17-meadow", "glow17-amber", "season17-snow"]);
function backgroundSection() {
  const on = showsBackground(), choice = bgChoice(), scrim = D.settings?.background?.scrim ?? 60;
  const kinds = [["none", "None"], ["painted", "Painted grove"], ["grove", "The grove", "bgset-grove"], ["oak3d", "The oak in 3D", "bgset-oak3d"], ["rings", "Growth rings", "bgset-rings"], ["own", "Your own"]];
  const scenes = SCENES.map(([v, n, f]) => `<button type="button" class="scene-c12${NEW_SCENES17.has(v) ? " new17e" : ""}" data-act="scene-set" data-v="${v}" ${pressed(choice === "painted" && W.scene === v)}>${f ? `<span class="sc-img12" data-css="background-image:url('${f}')"></span>` : `<span class="sc-img12 sc-auto12">${["spring", "autumn", "winter", "night"].map((k) => `<i data-css="background-image:url('/art/grove-${k}.webp')"></i>`).join("")}</span>`}<b>${esc(n)}</b></button>`).join("");
  const season = choice === "painted" ? segAct("Season", "Spring greens, autumn copper, winter snow; the forest at night in dark mode.", [["auto", "By the date"], ["spring", "Spring"], ["autumn", "Autumn"], ["winter", "Winter"]], W.season, "season") : "";
  return `<div class="sec"><h2>Background</h2>${segAct("Behind the glass", "The grove and the oak wear the theme’s colours. A scrim in the theme’s own colour keeps text readable.", kinds, choice, "bgset")}${season}${choice === "own" ? ownRows() : ""}<div class="fld"><span>Painted scenes</span><div class="scenes12">${scenes}</div></div>
    <div class="ctl"><b>How much the theme covers it</b><span class="right"><input class="range" type="range" id="scrim6" min="20" max="90" step="5" value="${scrim}" aria-label="How much the theme covers the background" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${scrim}%</span></span><small>More keeps text calmer; less shows more of the background.</small></div>
    <div class="ctl"><b>See-through panels</b><span class="right"><input class="range" type="range" id="see" min="0" max="60" step="5" value="${prefs().seeThrough ?? 30}" aria-label="See-through panels" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${prefs().seeThrough ?? 30}%</span></span><small>Panels blur what's behind them.</small></div>
    <div class="ctl"><b>Preview</b><span class="right"><button class="btn sm" type="button" data-act="bg-peek" ${on ? "" : "disabled"}>${ic("eye", "s")}See it clearly</button></span><small>Clear the view: see the background. Click anywhere or press Escape to come back.</small></div></div>`;
}

function readingSection() {
  const p = prefs();
  return `<div class="sec"><h2>Reading</h2>${segAct("Conversation width", "Wide uses more of a big screen.", [["comfortable", "Comfortable"], ["wide", "Wide"], ["full", "Full"]], p.conversationWidth, "widthset")}${segAct("Text size", "Changes every screen.", [["small", "Small"], ["medium", "Regular"], ["large", "Large"]], p.textSize, "size")}</div>`;
}

/* The pets the engine keeps (petKinds) that this window can draw (shell/scene.js), as the prototype's gallery names
   them: pass 17's picture pets (core/art17.js, each marked New, its walk playing on hover) before the pixel ones. The
   prototype's older picture pets and Little Branch are not in the engine's list. The row of buttons stays hidden, as
   there (after the gallery, so the first control for each pet is the one you can see). */
const PIXEL_PETS = [["squirrel", "Squirrel", "Pixel squirrel"], ["owl", "Owl", "Pixel owl"], ["hedgehog", "Hedgehog", "Pixel hedgehog"]];
function petCard(v, l, kind) {
  const pic = pet17(v);
  const face = pic ? `<img src="${pic.still}" alt="" loading="lazy" draggable="false" data-hov="${pic.walk}">` : `<span class="pet-px12">${v === "none" ? "—" : ic("spark", "s")}</span>`;
  return `<button type="button" class="pet-c12${pic ? " new17e" : ""}" data-act="petset" data-v="${v}" ${pressed(kind === v)}>${face}<b>${esc(l)}</b></button>`;
}
function petSection() {
  const pets = D.settings?.pets, kind = pets?.on ? pets.kind : "none", all = [["none", "None"], ...PETS17.map((p) => [p.id, p.name]), ...PIXEL_PETS.map(([v, , l]) => [v, l])];
  const row = segAct("Pet", "It walks along the foot of the list. Click it for a tip; it speaks up by itself only when a Trunk needs you.", [["none", "None"], ...PETS17.map((p) => [p.id, p.name]), ...PIXEL_PETS.map(([v, l]) => [v, l])], kind, "petset").replace('<div class="ctl">', '<div class="ctl" data-css="display:none">');
  const cards = all.map(([v, l]) => petCard(v, l, kind)).join("");
  const where = pets?.on ? segAct("Where it walks", "It keeps out of the way of your messages wherever it is.", [["side", "The list"], ["status", "Status bar"], ["dock", "By the message box", "petwhere15-dock"]], W.petWhere, "petwhere15") : "";
  const name = pets ? `<div class="ctl"><b>Name</b><span class="right"><input class="inp" id="pet-name" value="${esc(pets.name ?? "")}" aria-label="Pet name" maxlength="20" data-sw="set" data-css="width:140px"></span><small>Pat it for a tip.</small></div>` : "";
  return `<div class="sec"><h2>The pet</h2><div class="pets12">${cards}</div>${row}${where}${name}</div>`;
}

/* Each switch names a part of the window the engine keeps in preferences.hidden. */
const HIDES = [["h-usage", "usage", "The usage ring"], ["h-gateway", "gateway", "The gateway in the status bar"], ["h-pet", "pet", "The pet"], ["h-projects", "projects", "Projects in the list"], ["h-notes", "notes", "The Guide button"], ["h-statusbar", "statusbar", "The whole status bar"]];
function shownSection() {
  const hidden = prefs().hidden ?? [];
  const rows = HIDES.map(([id, k, l]) => `<div class="ctl"><b>${l}</b><input class="sw" type="checkbox" id="${id}" ${hidden.includes(k) ? "" : "checked"} aria-label="${l}" data-sw="hide" data-k="${k}"><small>${k === "statusbar" ? "Lockdown's banner and Stop while a task runs can never be hidden." : "Right-click it anywhere to hide it too."}</small></div>`).join("");
  return `<div class="sec"><h2>What’s shown</h2>${rows}
    <div class="ctl"><b>Keep things still</b><input class="sw" type="checkbox" id="a-still" aria-label="Keep things still" data-sw="still"><small>Stops the pet walking, the working ring, the logo's float and the background moving.</small></div>
    <div class="ctl"><b>Scenery behind the list</b><input class="sw" type="checkbox" id="a-scenery" aria-label="Scenery behind the list" data-sw="scenery"><small>A small pixel oak at the foot of the list.</small></div></div>
  <div class="sec"><h2>Language</h2><div class="ctl"><b>Language</b><span class="right"><select class="inp" id="lang" data-sw="lang" aria-label="Language"><option>English</option><option>Français</option><option>Español</option><option>Deutsch</option><option>Yorùbá</option></select></span><small>Dates and numbers follow it too.</small></div></div>`;
}

export function draw() {
  return `<h1>Appearance</h1><p class="lede">How Branch looks on this computer. Changes show as you pick.</p>
  <div class="sec"><h2>Light or dark</h2><div class="mirrors">${mirror("light")}${mirror("dark")}<button class="mirror" type="button" data-act="themeset" data-v="system" ${pressed(!document.documentElement.dataset.theme)}><span class="mm" data-css="grid-template-columns:1fr 1fr"><span data-css="background:#F8FAFB"></span><span data-css="background:#11161A"></span></span><b>Match this computer</b></button></div></div>
  ${themeSection()}${agentsSection()}${backgroundSection()}${readingSection()}${petSection()}${shownSection()}${appearance17(level17())}${picturesSection(level17())}`;
}

async function savePrefsAndDraw(change) {
  await savePrefs(change);
  await refresh().catch((error) => toast(error.message));
  renderNow();
}
async function setBackground(on) { await saveDelight({ background: { on } }); drawBackground(); renderNow(); }

/* A chosen file is checked against the prototype's kinds and limits, kept, and shown behind the glass. */
async function pickOwn(file) {
  const kind = await kindOf(file);
  if (!kind) { toast("That kind of file can’t go behind the glass."); return; }
  if (file.size > LIMITS[kind] * 1048576) { toast(`That file is ${(file.size / 1048576).toFixed(1)} MB. Keep it under ${LIMITS[kind]} MB for a ${kind}.`); return; }
  try { await keep(file, kind); } catch (error) { toast(error.message); return; }
  W.bg = "own";
  saveWindow();
  if (!D.settings?.background?.on) await saveDelight({ background: { on: true } });
  drawBackground();
  renderNow();
  toast("Kept on this computer. It is never sent anywhere.");
}
function removeDlg() {
  if (!OWN.saved) return;
  openDlg({ title: "Remove your background?", body: `<p data-css="margin:0">${esc(OWN.saved.name)} is thrown away from this window’s storage. Switching the background off would keep it for next time.</p>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Keep it</button><button class="btn bad" type="button" data-act="bg-remove-yes">Remove</button>' });
}
async function removeOwn() {
  try { await forget(); } catch (error) { toast(error.message); return; }
  W.bg = "painted";
  saveWindow();
  await saveDelight({ background: { on: false } });
  closeDlg();
  drawBackground();
  renderNow();
  toast("Removed. Nothing is kept.");
}
async function setFit(fit) { await saveDelight({ background: { fit } }); drawBackground(); renderNow(); }

export function init() {
  // "themeset" belongs to the shell, which applies the look and saves it to the engine; the theme controls are shell/themes.js.
  on("widthset", (el) => savePrefsAndDraw({ conversationWidth: el.dataset.v }));
  on("size", (el) => savePrefsAndDraw({ textSize: el.dataset.v }));
  on("bgset", (el) => { if (el.dataset.v === "painted" || el.dataset.v === "own") { W.bg = el.dataset.v; saveWindow(); } setBackground(el.dataset.v !== "none"); });
  on("bgfit", (el) => setFit(el.dataset.v));
  on("bg-remove", () => removeDlg());
  on("bg-remove-yes", () => removeOwn());
  on("scene-set", (el) => { W.scene = el.dataset.v; W.bg = "painted"; saveWindow(); if (!D.settings?.background?.on) setBackground(true); else { drawBackground(); renderNow(); } });
  on("season", (el) => { W.season = el.dataset.v; saveWindow(); drawBackground(); renderNow(); });
  on("bg-peek", () => document.getElementById("app").classList.add("peek"));
  on("petset", async (el) => { await saveDelight({ pets: el.dataset.v === "none" ? { on: false } : { on: true, kind: el.dataset.v } }); renderNow(); });
  on("petwhere15", (el) => { W.petWhere = el.dataset.v; saveWindow(); renderNow(); });
  on("ag-size", (el) => { saveUi({ size: el.dataset.v }); renderNow(); });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "bg-file6") { if (t.files?.[0]) pickOwn(t.files[0]); return; }
    if (t.id === "ag-show") { saveUi({ show: t.checked }); toast(t.checked ? "The agent is back beside the conversation." : "Hidden."); return; }
    if (t.id === "pet-name") { saveDelight({ pets: { name: t.value } }).then(() => renderNow()); return; }
    const row = HIDES.find(([id]) => id === t.id);
    if (!row) return;
    const k = row[1], hidden = (prefs().hidden ?? []).filter((x) => x !== k);
    savePrefsAndDraw({ hidden: t.checked ? hidden : [...hidden, k] });
  });
  /* "See it clearly" lasts until a click anywhere or Escape. */
  document.addEventListener("pointerdown", (e) => { const app = document.getElementById("app"); if (app.classList.contains("peek")) { app.classList.remove("peek"); e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener("keydown", (e) => { const app = document.getElementById("app"); if (e.key === "Escape" && app.classList.contains("peek")) { app.classList.remove("peek"); e.stopPropagation(); } }, true);
  load();
}

export async function load() {
  await loadDelight();
  renderNow();
}

export const live = {
  "widthset": true,
  "size": true,
  "bgset": true,
  "petset": true,
  "scene-set": true,
  "season": true,
  "bg-peek": true,
  "petwhere15": true,
  "ag-size": true,
  "sw:ag-show": true,
  "bgfit": true,
  "bg-remove": true,
  "bg-remove-yes": true,
  "sw:bg-file6": true,
  "sw:pet-name": true,
  "sw:h-usage": true,
  "sw:h-gateway": true,
  "sw:h-pet": true,
  "sw:h-projects": true,
  "sw:h-notes": true,
  "sw:h-statusbar": true,
};
