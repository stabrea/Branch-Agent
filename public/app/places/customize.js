/* Customize: Trunks, Tools, Specialists, Channels, Everywhere. Every list is the engine's: the Trunks (E.trunks), the
   tool servers (GET /api/mcp/connections), skills (E.state.skills), plugins (GET /api/plugins), other assistants
   (GET /api/agents/remote), suggested skills (GET /api/skills/suggest), better versions of skills
   (GET /api/skill-revisions) and the chat apps (GET /api/channel-setup, connected ones from GET /api/channels).
   A better version is tried, kept or thrown away through POST /api/skill-revisions/try|accept|reject; a suggested skill
   you have switched off is switched on through POST /api/skills/{id}/activate. */

import { esc, renderNow, paint } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, av, toast } from "../core/ui.js";
import { markLive, greyOut } from "../core/features.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { logo } from "../core/logos.js";
import { face, TEMPLATES } from "../flows/trunk.js";

function tabBar(tabs, place, current) {
  return `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current ? 'true' : 'false'}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;
}

let channelSetup = [];
let connected = [];
let mcpServers = [];
let plugins = [];
let agents = [];
let suggestions = [];
let revisions = [];
const T9 = { k: "mcp", sel: null };
const CH = { fam: "all", q: "" };

const KINDS = [
  ["mcp", "Connectors", "plug", "MCP servers: apps and data a Trunk can reach"],
  ["skills", "Skills", "bolt", "Step-by-step know-how, as SKILL.md"],
  ["plugins", "Plugins", "puzzle", "Packs of skills, servers and tools"],
  ["clis", "Command-line tools", "term", "Programs on this computer it may run"],
  ["agents", "Agents", "users", "Other assistants over A2A, and Trunks on other computers"],
];
/* Each kind's items as {id, name, sub}; command-line tools have no engine list, so none are drawn. */
function itemsOf(k) {
  if (k === "mcp") return mcpServers.map((s) => ({ id: s.id, name: s.id, sub: s.summary ?? "" }));
  if (k === "skills") return (E.state?.skills ?? []).map((s) => ({ id: s.id, name: s.activeName || s.name, sub: s.description ?? "" }));
  if (k === "plugins") return plugins.map((p) => ({ id: p.id ?? p.name, name: p.name ?? p.id, sub: p.description ?? "" }));
  if (k === "agents") return agents.map((a) => ({ id: a.name, name: a.name, sub: a.description ?? a.cardUrl ?? "" }));
  return [];
}
/* The add button: a server, a skill or an agent opens its dialog; a plugin or a tool has no engine form to show yet. */
const ADD = { mcp: ["tool-add", "Add a server"], skills: ["tool-add", "Add a skill"], plugins: ["plug-add", "Add a plugin"], clis: ["cli-add", "Add a tool"], agents: ["tool-add", "Connect another agent"] };

function trunksTab() {
  const rows = E.trunks.map((t) => `<div class="prow">${av(face(t), 36)}<span class="grow"><b>${esc(t.name)}</b><small>${esc(t.title ?? "")}</small></span>
    <button class="btn sm" type="button" data-act="edit" data-id="${esc(t.id)}">Edit</button>
    <button class="btn ghost sm" type="button" data-act="pausetrunk" data-id="${esc(t.id)}">Pause</button></div>`).join("");
  const jobs = TEMPLATES.map(([n, x, col], i) => `<div class="tile"><div class="th">${av({ name: n, color: col }, 34)}<b>${esc(n)}</b></div><p>${esc(x)}</p><div class="acts"><button class="btn sm" type="button" data-act="tmpl" data-i="${i}">Use this job</button></div></div>`).join("");
  return `<div class="rows"><div class="acts" data-css="margin:6px 0 4px"><button class="btn pri" type="button" data-act="new-trunk">${ic('plus', 's')}A new Trunk</button>
    <button class="btn" type="button" data-act="grp-new">${ic('room', 's')}A new room</button></div>${rows}
    <div class="sec"><h2>Start from a job</h2><div class="grid2">${jobs}</div></div></div>`;
}

/* The engine's changed lines, as the file history writes them: "+" added, "-" taken out, anything else kept. */
const diffLines = (diff) => String(diff ?? "").split("\n").map((l) => `<span class="${l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : ""}">${esc(l)}</span>`).join("");

/* The newest drafted version still waiting for a yes or a no. Each button names its skill and version, the exact body the
   engine's try, accept and reject take; switching a draft on without trying it (force) is never offered. */
function learnedCard() {
  const r = revisions.find((x) => !x.decision);
  if (T9.k !== "skills" || !r) return "";
  const at = `data-id="${esc(r.skillId)}" data-version="${esc(r.version)}"`;
  return `<div class="tile t9-learn"><div class="th"><b>A better version of “${esc(r.skillName)}”</b><span class="pill work ml"><i></i>Suggested</span></div><p>Nothing changes on its own.</p><pre class="diff6">${diffLines(r.diff)}</pre><div class="acts"><button class="btn sm" type="button" data-act="rev" data-v="tried" ${at}>${r.trial ? "Try again" : "Practice run on the last 3 tasks"}</button><button class="btn pri sm" type="button" data-act="rev" data-v="kept" ${at}>Keep it</button><button class="btn ghost sm" type="button" data-act="rev" data-v="gone" ${at}>Throw it away</button></div></div>`;
}

/* A switched-off skill you already have is switched on (sugg15). One a registry lists would be installed from that
   registry (POST /api/registry/install), which this engine's network rules keep from being tried here, so its Add is
   drawn under its own name and stays greyed. */
function suggested() {
  if (T9.k !== "skills" || !suggestions.length) return "";
  return `<div class="sugg15"><h3>Suggested for you</h3>${suggestions.map((s) => `<div class="sg-row15"><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.description)}</small></span><button type="button" class="btn sm" data-act="${s.source === "installed" ? "sugg15" : "sugg15-reg"}" data-v="${esc(s.id)}">Add</button></div>`).join("")}</div>`;
}

/* Which Trunks may use a server or a skill is drawn from each Trunk's own lists (servers by id, skills by name), and stays greyed: adding a server to a
   Trunk widens what it can reach. Remove is drawn for skills only: servers live in the launch file, and removing an
   assistant elsewhere could not be checked against this engine. */
function detail(k, x) {
  const list = k === "mcp" ? "mcpServers" : k === "skills" ? "skills" : null;
  const who = list ? `<div class="sec"><h2>Which Trunks may use it</h2><div class="chips8">${E.trunks.map((t) => `<button type="button" class="chip6" data-act="tool-who" data-k="${k}" data-id="${esc(x.id)}" data-v="${esc(t.id)}" aria-pressed="${(t[list] ?? []).includes(k === "skills" ? x.name : x.id)}">${esc(t.name)}</button>`).join("")}</div></div>` : "";
  const rm = k === "skills" ? `<span class="grow"></span><button class="btn ghost sm" type="button" data-act="tool-rm" data-k="${k}" data-id="${esc(x.id)}">Remove</button>` : "";
  return `<div class="t9-detail"><div class="t9-dh"><span class="ico-tile t9i" data-css="width:40px;height:40px">${ic(KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span></div>
    ${who}${rm ? `<div class="acts" data-css="margin-top:16px">${rm}</div>` : ""}</div>`;
}

function toolsTab() {
  const k = T9.k, items = itemsOf(k), sel = items.find((x) => x.id === T9.sel) ?? items[0];
  const nav = KINDS.map(([id, label, icon, desc]) => `<button type="button" data-act="t9-kind" data-v="${id}" aria-current="${k === id}">${ic(icon, 's')}<span><b>${esc(label)}</b><small>${esc(desc)}</small></span><em>${itemsOf(id).length}</em></button>`).join("");
  const [act, label] = ADD[k];
  const rows = items.map((x) => `<button type="button" class="t9-item" data-act="t9-sel" data-v="${esc(x.id)}" aria-current="${sel?.id === x.id}"><span class="ico-tile t9i" data-css="width:32px;height:32px">${ic(KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span></button>`).join("");
  return `<div class="t9"><nav class="t9-nav" aria-label="Kinds of tools">${nav}<button type="button" class="btn pri t9-addbtn" data-act="${act}" data-v="${k}">${ic('plus', 's')}${label}</button></nav>
    <div class="t9-list">${learnedCard()}${rows}${suggested()}</div>${sel ? detail(k, sel) : ""}</div>`;
}

function specialistsTab() {
  const specs = E.state.specialists || [];
  return `<div class="rows"><p class="hint">Helpers a Trunk calls in for one job, then lets go.</p>${specs.map((s) => `<div class="prow"><span class="ico-tile">${ic('bolt', 's')}</span>
    <span class="grow"><b>${esc(s.name || '')}</b><small>${esc(s.description || '')}</small></span>
    <button class="btn sm" type="button" data-act="spec-edit" data-id="${esc(s.id ?? "")}">Edit</button></div>`).join('')}</div>`;
}

const FAM_WORDS = { core: "Two minutes to set up", chat: "Text through a webhook" };
function channelGrid() {
  const q = CH.q.trim().toLowerCase();
  const on = new Set(connected.map((c) => c.id ?? c.kind));
  const list = channelSetup.filter((c) => (CH.fam === "all" || c.family === CH.fam) && (!q || String(c.name).toLowerCase().includes(q)));
  return list.map((c) => `<button type="button" class="ch12 ${on.has(c.id) ? "on12" : ""}" data-act="ch-open" data-v="${esc(c.id)}">${logo(c.id, c.name, 32)}<span><b>${esc(c.name)}</b><small>${on.has(c.id) ? "Connected · reaches Branch" : FAM_WORDS[c.family] ?? "Switch it on"}</small></span>${on.has(c.id) ? '<i class="dot12"></i>' : ""}</button>`).join("");
}

function channelsTab() {
  const fams = [["all", "All"], ["core", "Popular"], ["chat", "Work chat"], ["parity", "More"]].map(([v, l]) => `<button type="button" data-act="ch-fam" data-v="${v}" aria-pressed="${CH.fam === v}">${l}</button>`).join("");
  return `<p class="hint" data-css="margin:4px 0 10px">Talk to Branch from other apps. Each chat app reaches the Trunk you choose; with the gateway on, they work while Branch is closed.</p>
    <div class="ch-wrap12"><div class="ch-top12"><label class="set-search" data-css="margin:0;flex:1">${ic('search', 's')}<input id="ch-q" value="${esc(CH.q)}" placeholder="Search ${channelSetup.length} chat apps" aria-label="Search chat apps" autocomplete="off"></label>
    <span class="seg">${fams}</span></div>
    <div class="ch-grid12">${channelGrid()}</div><div class="tile phone12"><div class="th"><span class="ico-tile">${ic('phone', 's')}</span><b>Your phone</b></div><p>Answer approvals and talk to Trunks from the Branch app.</p>
    <div class="acts"><button class="btn pri sm" type="button" data-act="pair">Pair a phone</button></div></div></div>`;
}

function everywhereTab() {
  const version = E.state?.version ?? "";
  const tile = (icon, name, text, extra = "", v = "") => `<div class="tile"><div class="th"><span class="ico-tile">${ic(icon, 's')}</span><b>${name}</b></div><p>${text}</p><div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="${v}">Open this view</button>${extra}</div></div>`;
  const pair = '<button class="btn ghost sm" type="button" data-act="pair">Pair</button>';
  return `<div class="rows"><p class="hint" data-css="margin:4px 0 10px">One Branch, everywhere you are. Open any card to see that surface; the switcher in the title bar does the same.</p><div class="grid2">
    ${tile("win", "Windows", `This computer · Branch ${esc(version)}`, "", "desktop")}
    ${tile("mac", "Mac", "The same app on a Mac · menu bar icon with usage", "", "mac")}
    ${tile("term", "Terminal", "Type branch in any terminal. Same places, same theme", "", "terminal")}
    ${tile("phone", "iPhone", "Pair with the square code · lock screen answers", pair, "iphone")}
    ${tile("android", "Android", "Pair with the square code · answer from the notification", pair, "android")}
    ${tile("globe", "keepoak.com", "Connect your account to reach Branch from a browser", "", "web")}
    <div class="tile"><div class="th"><span class="ico-tile">${ic('chat', 's')}</span><b>Chat apps</b></div><p>Telegram, WhatsApp, Discord, Slack: talk to a Trunk from where you already are.</p><div class="acts"><button class="btn sm ml" type="button" data-act="ptab" data-place="customize" data-v="channels">Channels</button></div></div>
    <div class="tile"><div class="th"><span class="ico-tile">${ic('doc', 's')}</span><b>A page of your own</b></div><p>A small box on your own notes page or desk dashboard that asks Branch something. It talks only to your paired address, with its own key.</p><div class="acts"><button class="btn sm" type="button" data-act="widget6">Get the snippet</button></div></div>
    </div></div>`;
}

const DRAW = { trunks: trunksTab, tools: toolsTab, specialists: specialistsTab, channels: channelsTab, everywhere: everywhereTab };

export function draw() {
  const tab = S.tabs.customize || "trunks";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;
  const tabs = [["trunks", "Trunks", E.trunks.length], ["tools", "Tools", 0], ["specialists", "Specialists", 0], ["channels", "Channels", 0], ["everywhere", "Everywhere", 0]];
  const lockBanner = E.state.lock ? `<div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div>` : "";
  return `<main class="main enter11" id="main">${lockBanner}<div class="scroll"><div class="place${tab === "tools" ? " t9-place" : ""}">
    <h1>Customize</h1><p class="lede">Who your Trunks are, what they can do, and where you can reach them.</p>
    ${tabBar(tabs, "customize", tab)}${(DRAW[tab] ?? trunksTab)()}</div></div></main>`;
}

/* The engine answers with objects ({servers}, {channels}…); each is reduced to its list before it is kept, and the tab is
   drawn again only when a list really changed. A list the engine refuses is shown as its words, once. */
const listOf = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const said = new Set();
const read = (path) => api(path).catch((error) => { if (!said.has(path)) { said.add(path); toast(error.message); } return null; });

async function readTools() {
  const [mcp, plugs, ag, sug, rev] = await Promise.all([read("mcp/connections"), read("plugins"), read("agents/remote"), read("skills/suggest"), read("skill-revisions")]);
  return { mcpServers: listOf(mcp, "servers"), plugins: listOf(plugs, "plugins"), agents: listOf(ag, "agents"), suggestions: listOf(sug, "suggestions"), revisions: listOf(rev, "revisions") };
}

export async function after() {
  const tab = S.tabs.customize || "trunks";
  const before = JSON.stringify([mcpServers, plugins, agents, suggestions, revisions, channelSetup, connected]);
  if (tab === "tools") ({ mcpServers, plugins, agents, suggestions, revisions } = await readTools());
  else if (tab === "channels") {
    const [setup, live] = await Promise.all([read("channel-setup"), read("channels")]);
    channelSetup = listOf(setup, "channels");
    connected = listOf(live, "channels");
  }
  if (!same(before, JSON.stringify([mcpServers, plugins, agents, suggestions, revisions, channelSetup, connected]))) renderNow();
}

/* Removing a skill: POST /api/skills/{id}/remove, naming the revision it was shown at. */
async function removeTool(el) {
  const { k, id } = el.dataset;
  try {
    if (k !== "skills") return;
    await api(`skills/${encodeURIComponent(id)}/remove`, { expectedRevision: (E.state?.skills ?? []).find((s) => s.id === id)?.revision });
    const name = itemsOf(k).find((x) => x.id === id)?.name ?? "";
    T9.sel = null;
    await refresh();
    await after();
    renderNow();
    toast(`${name} removed.`);
  } catch (error) { toast(error.message); }
}

/* A drafted version: a practice run (POST /api/skill-revisions/try, where nothing is really done), keeping it (accept,
   which the engine refuses until a practice run did no worse) or throwing it away (reject). */
const REV = { tried: "try", kept: "accept", gone: "reject" };
async function revise(el) {
  const { v, id } = el.dataset, version = Number(el.dataset.version);
  const before = revisions.find((r) => r.skillId === id && r.version === version);
  el.disabled = true;
  try {
    await api(`skill-revisions/${REV[v]}`, { skillId: id, version });
    if (v === "tried") toast("Practice run done. Nothing was really changed.");
    if (v === "gone" && before?.activeVersion) toast(`Thrown away. The skill stays on version ${before.activeVersion}.`);
    await refresh();
  } catch (error) { toast(error.message); }
  el.disabled = false;
  await after();
  renderNow();
}

/* Switching on a skill you have: POST /api/skills/{id}/activate with the version and revision the engine has now. A skill
   the scan found something in is refused by the engine, in its own words. */
async function addSuggested(el) {
  try {
    const skill = await api(`skills/${encodeURIComponent(el.dataset.v)}`);
    await api(`skills/${encodeURIComponent(skill.id)}/activate`, { version: skill.headVersion, expectedRevision: skill.revision });
    await refresh();
  } catch (error) { toast(error.message); }
  await after();
  renderNow();
}

/* Filtering the chat apps redraws only the grid, so the search box keeps its caret. */
function redrawGrid() {
  const grid = document.querySelector("#main .ch-grid12");
  if (grid) greyOut(paint(grid, channelGrid()));
}

export function init() {
  markLive(["ptab", "t9-kind", "t9-sel", "tool-rm", "ch-fam", "rev", "sugg15"]);
  on("rev", (el) => revise(el));
  on("sugg15", (el) => addSuggested(el));
  on("t9-kind", (el) => { T9.k = el.dataset.v; T9.sel = null; renderNow(); });
  on("t9-sel", (el) => { T9.sel = el.dataset.v; renderNow(); });
  on("tool-rm", (el) => removeTool(el));
  on("ch-fam", (el) => { CH.fam = el.dataset.v; renderNow(); });
  document.addEventListener("input", (e) => { if (e.target.id === "ch-q") { CH.q = e.target.value; redrawGrid(); } });
}

/* Another area (the Add a skill dialog) shows a skill it just added. */
export function showTool(kind, id) {
  S.view = "customize";
  S.tabs.customize = "tools";
  T9.k = kind;
  T9.sel = id;
}
