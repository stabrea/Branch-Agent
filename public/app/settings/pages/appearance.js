/* Settings › Appearance, 1:1 with the prototype's page, from the engine: light or dark and the reading choices from the
   preferences (POST /api/preferences replaces the whole record, so shell/look.js lays each change over it), the theme
   from GET /api/look (the gallery and the colour editor are shell/themes.js), the background and the pet from the
   engine's delight switches (shell/scene.js). The painted scene, its season and where the pet walks are this window's. */

import { E, S, refresh } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { ic, toast } from "../../core/ui.js";
import { L, lookOf, lookEF, wornId, effMode, more, swatch, looks, savePrefs } from "../../shell/look.js";
import { ACCENTS } from "../../shell/themes.js";
import { D, W, SCENES, loadDelight, saveDelight, saveWindow, showsBackground, drawBackground } from "../../shell/scene.js";

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

function agentsSection() {
  return `<div class="sec"><h2>Agents</h2><div class="ctl"><b>Show the agent beside the conversation</b><input class="sw" type="checkbox" id="ag-show" aria-label="Show the agent beside the conversation" data-sw="set"><small>It acts out what the Trunk is doing: thinking, searching, reading, working, waiting for you, celebrating, resting.</small></div>${segAct("Size", "Small keeps it out of the way.", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], "", "ag-size")}</div>`;
}

function backgroundSection() {
  const on = showsBackground(), scrim = D.settings?.background?.scrim ?? 60;
  const kinds = [["none", "None"], ["painted", "Painted grove"], ["grove", "The grove", "bgset-grove"], ["oak3d", "The oak in 3D", "bgset-oak3d"], ["rings", "Growth rings", "bgset-rings"], ["own", "Your own", "bgset-own"]];
  const scenes = SCENES.map(([v, n, f]) => `<button type="button" class="scene-c12" data-act="scene-set" data-v="${v}" ${pressed(on && W.scene === v)}>${f ? `<span class="sc-img12" data-css="background-image:url('${f}')"></span>` : `<span class="sc-img12 sc-auto12">${["spring", "autumn", "winter", "night"].map((k) => `<i data-css="background-image:url('/art/grove-${k}.webp')"></i>`).join("")}</span>`}<b>${esc(n)}</b></button>`).join("");
  const season = on ? segAct("Season", "Spring greens, autumn copper, winter snow; the forest at night in dark mode.", [["auto", "By the date"], ["spring", "Spring"], ["autumn", "Autumn"], ["winter", "Winter"]], W.season, "season") : "";
  return `<div class="sec"><h2>Background</h2>${segAct("Behind the glass", "The grove and the oak wear the theme’s colours. A scrim in the theme’s own colour keeps text readable.", kinds, on ? "painted" : "none", "bgset")}${season}<div class="fld"><span>Painted scenes</span><div class="scenes12">${scenes}</div></div>
    <div class="ctl"><b>How much the theme covers it</b><span class="right"><input class="range" type="range" id="scrim6" min="20" max="90" step="5" value="${scrim}" aria-label="How much the theme covers the background" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${scrim}%</span></span><small>More keeps text calmer; less shows more of the background.</small></div>
    <div class="ctl"><b>See-through panels</b><span class="right"><input class="range" type="range" id="see" min="0" max="60" step="5" value="${prefs().seeThrough ?? 30}" aria-label="See-through panels" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${prefs().seeThrough ?? 30}%</span></span><small>Panels blur what's behind them.</small></div>
    <div class="ctl"><b>Preview</b><span class="right"><button class="btn sm" type="button" data-act="bg-peek" ${on ? "" : "disabled"}>${ic("eye", "s")}See it clearly</button></span><small>Clear the view: see the background. Click anywhere or press Escape to come back.</small></div></div>`;
}

function readingSection() {
  const p = prefs();
  return `<div class="sec"><h2>Reading</h2>${segAct("Conversation width", "Wide uses more of a big screen.", [["comfortable", "Comfortable"], ["wide", "Wide"], ["full", "Full"]], p.conversationWidth, "widthset")}${segAct("Text size", "Changes every screen.", [["small", "Small"], ["medium", "Regular"], ["large", "Large"]], p.textSize, "size")}</div>`;
}

function petSection() {
  const pets = D.settings?.pets, kind = pets?.on ? pets.kind : "none";
  const where = pets?.on ? segAct("Where it walks", "It keeps out of the way of your messages wherever it is.", [["side", "The list"], ["status", "Status bar"], ["dock", "By the message box", "petwhere15-dock"]], W.petWhere, "petwhere15") : "";
  return `<div class="sec"><h2>The pet</h2>${segAct("Pet", "It walks along the foot of the list. Click it for a tip; it speaks up by itself only when a Trunk needs you.", [["none", "None"], ["squirrel", "Squirrel"], ["owl", "Owl"], ["hedgehog", "Hedgehog"]], kind, "petset")}${where}</div>`;
}

/* Each switch names a part of the window the engine keeps in preferences.hidden. */
const HIDES = [["h-usage", "usage", "The usage ring"], ["h-gateway", "gateway", "The gateway in the status bar"], ["h-pet", "pet", "The pet"], ["h-projects", "projects", "Projects in the list"], ["h-notes", "notes", "The Guide button"], ["h-statusbar", "statusbar", "The whole status bar"]];
function shownSection() {
  const hidden = prefs().hidden ?? [];
  const rows = HIDES.map(([id, k, l]) => `<div class="ctl"><b>${l}</b><input class="sw" type="checkbox" id="${id}" ${hidden.includes(k) ? "" : "checked"} aria-label="${l}" data-sw="hide" data-k="${k}"><small>${k === "statusbar" ? "Lockdown's banner and Stop while a task runs can never be hidden." : "Right-click it anywhere to hide it too."}</small></div>`).join("");
  return `<div class="sec"><h2>What's shown</h2>${rows}
    <div class="ctl"><b>Keep things still</b><input class="sw" type="checkbox" id="a-still" aria-label="Keep things still" data-sw="still"><small>Stops the pet walking, the working ring, the logo's float and the background moving.</small></div>
    <div class="ctl"><b>Scenery behind the list</b><input class="sw" type="checkbox" id="a-scenery" aria-label="Scenery behind the list" data-sw="scenery"><small>A small pixel oak at the foot of the list.</small></div></div>
  <div class="sec"><h2>Language</h2><div class="ctl"><b>Language</b><span class="right"><select class="inp" id="lang" data-sw="lang" aria-label="Language"><option>English</option><option>Français</option><option>Español</option><option>Deutsch</option><option>Yorùbá</option></select></span><small>Dates and numbers follow it too.</small></div></div>`;
}

export function draw() {
  return `<h1>Appearance</h1><p class="lede">How Branch looks on this computer. Changes show as you pick.</p>
  <div class="sec"><h2>Light or dark</h2><div class="mirrors">${mirror("light")}${mirror("dark")}<button class="mirror" type="button" data-act="themeset" data-v="system" ${pressed(!document.documentElement.dataset.theme)}><span class="mm" data-css="grid-template-columns:1fr 1fr"><span data-css="background:#F8FAFB"></span><span data-css="background:#11161A"></span></span><b>Match this computer</b></button></div></div>
  ${themeSection()}${agentsSection()}${backgroundSection()}${readingSection()}${petSection()}${shownSection()}`;
}

async function savePrefsAndDraw(change) {
  await savePrefs(change);
  await refresh().catch((error) => toast(error.message));
  renderNow();
}
async function setBackground(on) { await saveDelight({ background: { on } }); drawBackground(); renderNow(); }

export function init() {
  // "themeset" belongs to the shell, which applies the look and saves it to the engine; the theme controls are shell/themes.js.
  on("widthset", (el) => savePrefsAndDraw({ conversationWidth: el.dataset.v }));
  on("size", (el) => savePrefsAndDraw({ textSize: el.dataset.v }));
  on("bgset", (el) => { if (el.dataset.v === "painted") { W.bg = "painted"; saveWindow(); } setBackground(el.dataset.v !== "none"); });
  on("scene-set", (el) => { W.scene = el.dataset.v; W.bg = "painted"; saveWindow(); if (!D.settings?.background?.on) setBackground(true); else { drawBackground(); renderNow(); } });
  on("season", (el) => { W.season = el.dataset.v; saveWindow(); drawBackground(); renderNow(); });
  on("bg-peek", () => document.getElementById("app").classList.add("peek"));
  on("petset", async (el) => { await saveDelight({ pets: el.dataset.v === "none" ? { on: false } : { on: true, kind: el.dataset.v } }); renderNow(); });
  on("petwhere15", (el) => { W.petWhere = el.dataset.v; saveWindow(); renderNow(); });
  document.addEventListener("change", (e) => {
    const t = e.target;
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
  "sw:h-usage": true,
  "sw:h-gateway": true,
  "sw:h-pet": true,
  "sw:h-projects": true,
  "sw:h-notes": true,
  "sw:h-statusbar": true,
};
