/* Customize: Trunks, Tools, Specialists, Channels, Everywhere. */

import { esc, renderNow } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av, toast, openDlg } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openTrunkEditor } from "../flows/trunk.js";

function tabBar(tabs, place, current) {
  return `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current ? 'true' : 'false'}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;
}

let channelSetup = [];
let devices = [];
let channels = [];
let mcpConnections = [];
let skills = [];
let plugins = [];
let toolsCatalog = [];
let toolsSelectedKind = "mcp";
let toolsSelectedId = null;

export function draw() {
  const tab = S.tabs.customize || "trunks";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const trunks = E.trunks || [];
  const tabs = [
    ["trunks", "Trunks", trunks.length],
    ["tools", "Tools", 0],
    ["specialists", "Specialists", 0],
    ["channels", "Channels", 0],
    ["everywhere", "Everywhere", 0]
  ];

  const lockBanner = E.state.lock ? `<div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div>` : "";

  let html = `<main class="main enter11" id="main">${lockBanner}<div class="scroll"><div class="place">
    <h1>Customize</h1><p class="lede">Who your Trunks are, what they can do, and where you can reach them.</p>
    ${tabBar(tabs, "customize", tab)}`;

  if (tab === "trunks") {
    html += `<div class="rows"><div class="acts" data-css="margin:6px 0 4px"><button class="btn pri" type="button" data-act="new-trunk">${ic('plus', 's')}A new Trunk</button>
      <button class="btn" type="button" data-act="grp-new">${ic('people', 's')}A new room</button></div>`;
    if (trunks.length) {
      html += trunks.map(t => {
        const avClass = t.paused ? " waiting" : "";
        return `<div class="prow">${av(t, 36)}<span class="grow">
        <b>${esc(t.name || '')}</b><small>${esc(t.role || '')}</small></span>
        <button class="btn sm" type="button" data-act="edit" data-id="${esc(t.id || '')}">Edit</button>
        <button class="btn ghost sm" type="button" data-act="pausetrunk" data-id="${esc(t.id || '')}">${t.paused ? 'Resume' : 'Pause'}</button></div>`;
      }).join('');
    }
    html += `</div>`;
  } else if (tab === "tools") {
    const kinds = [
      ["mcp", "Connectors", mcpConnections.length, "MCP servers: apps and data a Trunk can reach"],
      ["skills", "Skills", skills.length, "Step-by-step know-how, as SKILL.md"],
      ["plugins", "Plugins", plugins.length, "Packs of skills, servers and tools"],
      ["clis", "Command-line tools", toolsCatalog.length, "Programs on this computer it may run"],
      ["agents", "Agents", 0, "Other assistants over A2A, and Trunks on other computers"]
    ];
    const currentKind = toolsSelectedKind;
    const kindIcons = {mcp:"plug", skills:"bolt", plugins:"puzzle", clis:"term", agents:"users"};

    html += `<div class="t9"><nav class="t9-nav" aria-label="Kinds of tools">`;
    kinds.forEach(([k, label, count, desc]) => {
      html += `<button type="button" data-act="t9-kind" data-v="${esc(k)}" aria-current="${k === currentKind ? 'true' : 'false'}">
        ${ic(kindIcons[k] || 'wrench', 's')}<span><b>${esc(label)}</b><small>${esc(desc)}</small></span><em>${count}</em></button>`;
    });
    html += `<button type="button" class="btn pri t9-addbtn" data-act="tool-add" data-v="${esc(currentKind)}">${ic('plus', 's')}Add a server</button></nav>
    <div class="t9-list">`;

    const currentTools = currentKind === "mcp" ? mcpConnections : currentKind === "skills" ? skills : currentKind === "plugins" ? plugins : currentKind === "clis" ? toolsCatalog : [];
    if (currentTools.length) {
      currentTools.forEach(tool => {
        const isSelected = tool.id === toolsSelectedId;
        html += `<button type="button" class="t9-item" data-act="t9-sel" data-v="${esc(tool.id || '')}" aria-current="${isSelected ? 'true' : 'false'}">
          <span class="ico-tile">${ic('wrench', 's')}</span>
          <span class="grow"><b>${esc(tool.name || '')}</b><small>${esc(tool.description || '')}</small></span>
        </button>`;
      });
    }
    html += `</div></div>`;
  } else if (tab === "specialists") {
    const specs = E.state.specialists || [];
    html += `<div class="rows"><p class="hint">Helpers a Trunk calls in for one job, then lets go.</p>`;
    if (specs.length) {
      html += specs.map(s => `<div class="prow"><span class="ico-tile">${ic('zap', 's')}</span>
        <span class="grow"><b>${esc(s.name || '')}</b><small>${esc(s.description || '')}</small></span>
        <button class="btn sm" type="button" data-act="toast" data-msg="Edit what ${esc(s.name || '')} may do.">Edit</button></div>`).join('');
    }
    html += `</div>`;
  } else if (tab === "channels") {
    const channelCount = channelSetup.length;
    html += `<p class="hint" data-css="margin:4px 0 10px">Talk to Branch from other apps. Each chat app reaches the Trunk you choose; with the gateway on, they work while Branch is closed.</p>
      <div class="ch-wrap12"><div class="ch-top12"><label class="set-search" data-css="margin:0;flex:1"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4-4"></path></svg><input id="ch-q" value="" placeholder="Search ${channelCount} chat apps" aria-label="Search chat apps" autocomplete="off"></label>
      <span class="seg"><button type="button" data-act="ch-fam" data-v="all" aria-pressed="true">All</button><button type="button" data-act="ch-fam" data-v="core" aria-pressed="false">Popular</button><button type="button" data-act="ch-fam" data-v="chat" aria-pressed="false">Work chat</button><button type="button" data-act="ch-fam" data-v="parity" aria-pressed="false">More</button></span></div>
      <div class="ch-grid12">`;
    if (channelSetup.length) {
      html += channelSetup.map(ch => {
        const logo = `<span class="logo" data-css="width:32px;height:32px;background:${ch.color || '#666'}"><b data-css="font:700 11px var(--sans);color:#fff">${esc((ch.name || '').substring(0, 2).toUpperCase())}</b></span>`;
        return `<button type="button" class="ch12" data-act="ch-open" data-v="${esc(ch.id)}"><span class="logo">${logo}</span><span><b>${esc(ch.name)}</b><small>${esc(ch.status || 'Two minutes to set up')}</small></span></button>`;
      }).join('');
    }
    html += `</div><div class="tile phone12"><div class="th"><span class="ico-tile">${ic('phone', 's')}</span><b>Your phone</b></div><p>Answer approvals and talk to Trunks from the Branch app.</p>
      <div class="acts"><button class="btn pri sm" type="button" data-act="pair">Pair a phone</button></div></div></div>`;
  } else if (tab === "everywhere") {
    const version = E.state.version || "0.20.0";
    html += `<div class="rows"><p class="hint" data-css="margin:4px 0 10px">One Branch, everywhere you are. Open any card to see that surface; the switcher in the title bar does the same.</p>
      <div class="grid2">
      <div class="tile"><div class="th"><span class="ico-tile">${ic('desktop', 's')}</span><b>Windows</b></div><p>This computer · Branch ${esc(version)}</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="desktop">Open this view</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('monitor', 's')}</span><b>Mac</b></div><p>The same app on a Mac · menu bar icon with usage</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="mac">Open this view</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('terminal', 's')}</span><b>Terminal</b></div><p>Type branch in any terminal. Same places, same theme</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="terminal">Open this view</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('phone', 's')}</span><b>iPhone</b></div><p>Pair with the square code · lock screen answers</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="iphone">Open this view</button><button class="btn ghost sm" type="button" data-act="pair">Pair</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('phone', 's')}</span><b>Android</b></div><p>Pair with the square code · answer from the notification</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="android">Open this view</button><button class="btn ghost sm" type="button" data-act="pair">Pair</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('globe', 's')}</span><b>keepoak.com</b></div><p>Connect your account to reach Branch from a browser</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="web">Open this view</button></div></div>
      <div class="tile"><div class="th"><span class="ico-tile">${ic('chat', 's')}</span><b>Chat apps</b></div><p>Telegram, WhatsApp, Discord, Slack: talk to a Trunk from where you already are.</p>
        <div class="acts"><button class="btn sm ml" type="button" data-act="ptab" data-place="customize" data-v="channels">Channels</button></div></div>
      </div></div>`;
  }

  html += `</div></div></main>`;
  return html;
}

/* The engine answers with objects ({servers}, {channels}, {devices}…); each is reduced to its list before it is kept, and
   the tab is drawn again only when a list really changed. */
const listOf = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function after() {
  const tab = S.tabs.customize || "trunks";
  let changed = false;
  const keep = (current, fresh, set) => { if (!same(current, fresh)) { set(fresh); changed = true; } };
  if (tab === "tools") {
    const [mcp, cat, plugs] = await Promise.all([api("mcp/connections").catch(() => null), api("tools/catalog").catch(() => null), api("plugins").catch(() => null)]);
    keep(mcpConnections, listOf(mcp, "servers"), (v) => { mcpConnections = v; });
    keep(toolsCatalog, listOf(cat, "tools"), (v) => { toolsCatalog = v; });
    keep(plugins, listOf(plugs, "plugins"), (v) => { plugins = v; });
    skills = E.state.skills || [];
  } else if (tab === "channels") {
    keep(channelSetup, listOf(await api("channel-setup").catch(() => null), "channels"), (v) => { channelSetup = v; });
  } else if (tab === "everywhere") {
    const [dev, ch] = await Promise.all([api("devices").catch(() => null), api("channels").catch(() => null)]);
    keep(devices, listOf(dev, "devices"), (v) => { devices = v; });
    keep(channels, listOf(ch, "channels"), (v) => { channels = v; });
  }
  if (changed) renderNow();
}

export function init() {
  markLive(["ptab", "t9-kind", "t9-sel", "new-trunk", "edit", "pausetrunk", "tool-add", "grp-new", "grp-make"]);

  on("ptab", (el) => {
    const place = el.dataset.place;
    const tab = el.dataset.v;
    if (place === "customize") S.tabs.customize = tab;
    renderNow();
  });

  on("t9-kind", (el) => {
    toolsSelectedKind = el.dataset.v;
    renderNow();
  });

  on("t9-sel", (el) => {
    toolsSelectedId = el.dataset.v;
    renderNow();
  });

  on("new-trunk", () => openTrunkEditor());

  on("edit", (el) => openTrunkEditor(el.dataset.id));

  on("pausetrunk", async (el) => {
    const id = el.dataset.id;
    const trunk = E.trunks?.find(t => t.id === id);
    if (!trunk) return;
    const newPausedState = !trunk.paused;
    try {
      await api(`trunks/${id}`, { paused: newPausedState }, "PUT");
      renderNow();
      toast(`${trunk.name} is ${newPausedState ? 'paused' : 'resumed'}.`);
    } catch (err) {
      toast(err.message);
    }
  });

  on("grp-new", () => openGroupDialog());

  on("grp-make", async (el) => {
    const roomName = document.querySelector("#grp-name")?.value?.trim();
    if (!roomName) {
      toast("Room needs a name.");
      return;
    }
    const trunks = Array.from(document.querySelectorAll('input[data-act="grp-pick"]:checked')).map(el => el.dataset.id);
    if (trunks.length < 2) {
      toast("Pick at least two Trunks for a room.");
      return;
    }
    try {
      await api("trunks/rooms", { name: roomName, trunks }, "POST");
      const dlg = document.querySelector(".dlg");
      dlg?.remove?.();
      renderNow();
      toast(`Room "${roomName}" is made.`);
    } catch (err) {
      toast(err.message);
    }
  });
}

function openGroupDialog() {
  const trunks = E.trunks || [];
  const html = `<div style="display:grid;gap:12px">
    <label><input type="text" id="grp-name" placeholder="Room name" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box"></label>
    <div style="display:grid;gap:8px">
      ${trunks.map(t => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-act="grp-pick" data-id="${esc(t.id)}"> ${esc(t.name)}</label>`).join('')}
    </div>
    <small style="color:#666">Pick at least two Trunks. Other people can be added later.</small>
  </div>`;

  openDlg({
    title: "New room",
    body: html,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="grp-make">Make room</button>`
  });
}
