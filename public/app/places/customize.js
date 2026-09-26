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
let policyRules = [];
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
  if (k === "mcp") return mcpServers.map((s) => ({ id: s.id, name: s.id, sub: s.summary ?? "", error: s.lastError ?? "" }));
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
  return `<div class="rows"><div class="acts" data-css="margin:6px 0 4px"><button class="btn pri" type="button" data-act="chat" data-id="new">${ic('plus', 's')}A new Trunk</button>
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

/* What each of a server's tools may do: its tools are the engine's own list (GET /api/state tools, named mcp.<server>.…),
   shown by the description the server gave; the pressed choice is the approval rule that names that exact tool, else none.
   Every choice stays greyed (seg has no handler): changing one loosens or tightens approvals. */
const DECISIONS = [["allow", "Allowed"], ["ask", "Ask first"], ["deny", "Never"]];
function toolPerms(x) {
  const tools = (E.state?.tools ?? []).filter((t) => t.name.startsWith(`mcp.${x.id}.`));
  const rows = tools.map((t) => {
    const rule = policyRules.find((r) => r.tool === t.name);
    return `<div class="prow t9-perm"><code>${esc(t.description)}</code><span class="grow"></span><span class="seg">${DECISIONS.map(([d, l]) => `<button type="button" data-act="seg" aria-pressed="${rule?.decision === d}">${l}</button>`).join("")}</span></div>`;
  }).join("");
  return `<div class="sec"><h2>What each tool may do</h2><div class="rows">${rows}</div></div>`;
}
/* A server that would not start says why, in the engine's words; trying again and its log stay greyed. */
const startProblem = (x) => (x.error ? `<div class="status"><span class="sdot bad"></span><div><b>It didn’t start</b><p>${esc(String(x.error).replace(/\.$/, ""))}. <button class="link" type="button" data-act="tool-retry">Try again</button> · <button class="link" type="button" data-act="tool-log">See its log</button></p></div></div>` : "");
/* Remove is live for skills only (tool-rm). A server lives in the launch file and a plugin or an agent here has no removal
   this window checks, so theirs is drawn disabled. Test it would start the server's program, and no route checks a
   server or a tool for updates, so both stay greyed under their own names. */
function detailActs(k, x) {
  const rmOff = k === "skills" ? "" : ' disabled aria-disabled="true" data-tip="Coming soon"';
  const test = k === "mcp" ? '<button class="btn sm" type="button" data-act="tool-test">Test it</button>' : "";
  return `<div class="acts" data-css="margin-top:16px">${test}<button class="btn sm" type="button" data-act="tool-upd">Check for updates</button><span class="grow"></span><button class="btn ghost sm${rmOff ? " soon" : ""}" type="button" data-act="tool-rm" data-k="${k}" data-id="${esc(x.id)}"${rmOff}>Remove</button></div>`;
}
/* Which Trunks may use a server or a skill is drawn from each Trunk's own lists (servers by id, skills by name), and stays
   greyed: adding a server to a Trunk widens what it can reach. */
/* Branch's own assistant, by its name (state.identity): it may use a server whose tools are in its list (state.tools). */
const mainChip = (x) => `<button type="button" class="chip6" data-act="tool-who" data-k="mcp" data-id="${esc(x.id)}" data-v="main" aria-pressed="${(E.state?.tools ?? []).some((t) => t.name.startsWith(`mcp.${x.id}.`))}">${esc(E.state?.identity?.name ?? "")}</button>`;
function detail(k, x) {
  const list = k === "mcp" ? "mcpServers" : k === "skills" ? "skills" : null;
  const who = list ? `<div class="sec"><h2>Which Trunks may use it</h2><div class="chips8">${E.trunks.map((t) => `<button type="button" class="chip6" data-act="tool-who" data-k="${k}" data-id="${esc(x.id)}" data-v="${esc(t.id)}" aria-pressed="${(t[list] ?? []).includes(k === "skills" ? x.name : x.id)}">${esc(t.name)}</button>`).join("")}${k === "mcp" ? mainChip(x) : ""}</div></div>` : "";
  const onOff = k === "mcp" ? `<input type="checkbox" class="sw" data-sw="tool9g" data-k="${k}" data-id="${esc(x.id)}" aria-label="${esc(x.name)} on or off">` : "";
  return `<div class="t9-detail"><div class="t9-dh"><span class="ico-tile t9i" data-css="width:40px;height:40px">${ic(KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span>${onOff}</div>
    ${startProblem(x)}${who}${k === "mcp" ? toolPerms(x) : ""}${detailActs(k, x)}</div>`;
}

function toolsTab() {
  const k = T9.k, items = itemsOf(k), sel = items.find((x) => x.id === T9.sel) ?? items[0];
  const nav = KINDS.map(([id, label, icon, desc]) => `<button type="button" data-act="t9-kind" data-v="${id}" aria-current="${k === id}">${ic(icon, 's')}<span><b>${esc(label)}</b><small>${esc(desc)}</small></span><em>${itemsOf(id).length}</em></button>`).join("");
  const [act, label] = ADD[k];
  const rows = items.map((x) => `<button type="button" class="t9-item" data-act="t9-sel" data-v="${esc(x.id)}" aria-current="${sel?.id === x.id}"><span class="ico-tile t9i" data-css="width:32px;height:32px">${ic(KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span></button>`).join("");
  return `<div class="t9"><nav class="t9-nav" aria-label="Kinds of tools">${nav}<button type="button" class="btn pri t9-addbtn" data-act="${act}" data-v="${k}">${ic('plus', 's')}${label}</button></nav>
    <div class="t9-list">${learnedCard()}${rows}${suggested()}</div>${sel ? detail(k, sel) : ""}</div>`;
}

/* The engine keeps each specialist as {id, data: {definition: {name, instructions}}}. */
const specName = (s) => s.data?.definition?.name ?? "";
const specWhat = (s) => String(s.data?.definition?.instructions ?? "").split("\n")[0];

/* The prototype's patterns. The engine picks supervisor, swarm or router per job and keeps no owner setting for a default
   pattern, so none is checked and pat15 stays greyed (FEATURE-AUDIT: soon). */
const PATTERNS = [
  ["one", "One at a time", "A Trunk calls a specialist, waits, carries on.", "M30 14v14M30 38v10", [[30, 10], [30, 33], [30, 52]]],
  ["super", "A lead and helpers", "One Trunk plans and hands out the parts.", "M30 14L14 42M30 14v28M30 14l16 28", [[30, 10], [14, 46], [30, 46], [46, 46]]],
  ["swarm", "Swarm", "Equals pass the work to whoever fits best.", "M14 18L46 18M14 18L30 46M46 18L30 46", [[14, 18], [46, 18], [30, 46]]],
  ["router", "Router", "Sends each request to the one Trunk that matches.", "M10 30h12M22 30l20-16M22 30h20M22 30l20 16", [[8, 30], [22, 30], [46, 14], [46, 30], [46, 46]]],
  ["parallel", "In parallel", "The same job split up, then gathered.", "M30 10L14 30M30 10v20M30 10l16 20M14 30L30 50M30 30v20M46 30L30 50", [[30, 8], [14, 30], [30, 30], [46, 30], [30, 52]]],
  ["teams", "Teams", "Small groups, each with its own lead.", "M18 12L10 30M18 12l8 18M42 12l-8 18M42 12l8 18M18 12h24", [[18, 12], [42, 12], [10, 32], [26, 32], [34, 32], [50, 32]]],
];
const patSvg = ([, , , d, dots]) => `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="${d}"></path>${dots.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 0 ? 5 : 4}" class="${i === 0 ? "lead15" : ""}"></circle>`).join("")}</svg>`;

/* Who is on call: the engine's Trunks and Branch's own assistant, how many tasks are working, how many specialists. */
function fleet(specs) {
  const n = E.trunks.length, working = (E.state.runs ?? []).filter((r) => r.status === "running").length;
  const dots = [...E.trunks.map((t) => av(face(t), 22)), av({ kind: "main" }, 22)].join("");
  return `<div class="fleet15"><span class="fl-dots15">${dots}</span><span><b>${n} ${n === 1 ? "Trunk" : "Trunks"}</b><small>${working} working now · ${specs.length} ${specs.length === 1 ? "specialist" : "specialists"} on call</small></span></div>`;
}

function specialistsTab() {
  const specs = E.state.specialists || [];
  const rows = specs.map((s) => `<div class="prow"><span class="ico-tile">${ic('bolt', 's')}</span><span class="grow"><b>${esc(specName(s))}</b><small>${esc(specWhat(s))}</small></span><button class="btn sm" type="button" data-act="spec-edit" data-id="${esc(s.id ?? "")}">Edit</button></div>`).join('');
  const pats = PATTERNS.map((p) => `<button type="button" role="radio" class="pat15" aria-checked="false" data-act="pat15" data-v="${p[0]}">${patSvg(p)}<b>${esc(p[1])}</b><small>${esc(p[2])}</small></button>`).join("");
  return `<div class="rows"><p class="hint" data-css="margin:4px 0 8px">Helpers a Trunk calls in for one job, then lets go.</p>${rows}</div>
    <div class="sec x15-sec">${fleet(specs)}<h2 data-css="margin-top:22px">How Trunks work together</h2><p class="hint" data-css="margin:0 0 10px">The pattern a room or a big task uses. Branch picks one; you can choose.</p>
    <div class="pats15" role="radiogroup" aria-label="How Trunks work together">${pats}</div></div>`;
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
  const [mcp, plugs, ag, sug, rev, pol] = await Promise.all([read("mcp/connections"), read("plugins"), read("agents/remote"), read("skills/suggest"), read("skill-revisions"), read("policy")]);
  return { mcpServers: listOf(mcp, "servers"), plugins: listOf(plugs, "plugins"), agents: listOf(ag, "agents"), suggestions: listOf(sug, "suggestions"), revisions: listOf(rev, "revisions"), policyRules: listOf(pol?.policy, "rules") };
}

export async function after() {
  const tab = S.tabs.customize || "trunks";
  const before = JSON.stringify([mcpServers, plugins, agents, suggestions, revisions, policyRules, channelSetup, connected]);
  if (tab === "tools") ({ mcpServers, plugins, agents, suggestions, revisions, policyRules } = await readTools());
  else if (tab === "channels") {
    const [setup, live] = await Promise.all([read("channel-setup"), read("channels")]);
    channelSetup = listOf(setup, "channels");
    connected = listOf(live, "channels");
  }
  if (!same(before, JSON.stringify([mcpServers, plugins, agents, suggestions, revisions, policyRules, channelSetup, connected]))) renderNow();
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
  markLive(["sw:ch-q", "ptab", "t9-kind", "t9-sel", "tool-rm", "ch-fam", "rev", "sugg15"]);
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
