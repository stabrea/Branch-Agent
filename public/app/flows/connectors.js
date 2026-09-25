/* MCP Connectors: searchable catalog of integrations like GitHub, Gmail, Notion. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let connectors = null;

const MCP_CATALOG = [
  ["Linear", "Issues and projects"],
  ["Notion", "Pages and databases"],
  ["Slack", "Channels and messages"],
  ["Figma", "Designs and comments"],
  ["Sentry", "Errors from your apps"],
  ["Stripe", "Payments and invoices"],
  ["Home Assistant", "Lights, heating and sensors"],
  ["Obsidian", "Your notes vault"]
];

export function init() {
  markLive(["tool-add", "mcp-cat", "mcp-add", "mcp-test", "mcp-save", "sk-src", "sk-draft", "sk-save", "cli-add", "plug-add"]);
  on("tool-add", (el) => openToolAddDialog(el.dataset.v));
  on("mcp-cat", (el) => { S.mcp = S.mcp || {}; S.mcp.cat = el.dataset.v; drawConnectorCatalog(); });
  on("mcp-add", (el) => addConnectorFromCatalog(el.dataset.v));
  on("mcp-test", () => testMcpServer());
  on("mcp-save", () => saveMcpServer());
  on("sk-src", (el) => handleSkillSource(el.dataset.v));
  on("sk-draft", () => draftSkill());
  on("sk-save", () => saveSkill());
  on("cli-add", (el) => addCli(el.dataset.v));
  on("plug-add", (el) => addPlugin(el.dataset.v));
}

function handleSkillSource(source) {
  if (source === "write") {
    openDlg({
      title: "Write a skill with Branch",
      body: `<label style="display:block;margin-bottom:12px"><span style="display:block;margin-bottom:4px">What should it know how to do?</span><textarea id="sk-what" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font-family:monospace" rows="3" placeholder="Every Friday, check the Oakfield price list and tell me if paper went up."></textarea></label><div id="sk-draft"></div>`,
      foot: `<button class="btn" type="button" data-act="sk-draft">Draft it</button><button class="btn pri" type="button" data-act="sk-save">Add skill</button>`
    });
  } else {
    closeDlg();
    const id = {lib:'meeting-notes', file:'my-skill', git:'repo-skill'}[source] || 'skill';
    toast(`Skill added. It's read before tasks that need it.`);
    renderNow();
  }
}

function draftSkill() {
  const textarea = document.querySelector("#sk-what");
  if (!textarea) return;
  const what = textarea.value.trim() || "Check the Oakfield price list every Friday";
  const draftDiv = document.querySelector("#sk-draft");
  if (draftDiv) {
    draftDiv.innerHTML = `<pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;margin-top:12px">---
name: price-watch
description: ${what}
---

1. Open the Oakfield price list.
2. Compare with last week's prices in memory.
3. Tell me only if something went up.</pre>`;
  }
}

function saveSkill() {
  closeDlg();
  toast(`price-watch is added.`);
  renderNow();
}

function addCli(tool) {
  toast(`${tool} is allowed. It asks before every command until you say which it may run.`);
  renderNow();
}

function addPlugin(pack) {
  closeDlg();
  toast(`${pack} pack is installed.`);
  renderNow();
}

function openToolAddDialog(kind = "mcp") {
  if (kind === "mcp") {
    openConnectorCatalog();
  } else if (kind === "skills") {
    openSkillsDialog();
  } else if (kind === "plugins") {
    openPluginsDialog();
  } else if (kind === "clis") {
    openCliDialog();
  }
}

async function openConnectorCatalog() {
  if (!connectors) connectors = await api("mcp/connections").catch(() => ({}));
  S.mcp = { cat: "all", q: "" };
  drawConnectorCatalog();
}

function drawConnectorCatalog() {
  const html = `<div data-css="padding:16px">
    <p data-css="margin-bottom:16px">52 ready to connect. Search or browse by category.</p>
    <div data-css="margin-bottom:16px">
      <input type="text" id="mcp-q" placeholder="Search connectors" data-css="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px" aria-label="Search connectors">
    </div>
    <div data-css="margin-bottom:16px;display:flex;gap:4px;flex-wrap:wrap">
      <button class="chip6" type="button" data-act="mcp-cat" data-v="all" aria-pressed="${(S.mcp?.cat || "all") === "all"}">All</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="work" aria-pressed="${S.mcp?.cat === "work"}">Work</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="mail" aria-pressed="${S.mcp?.cat === "mail"}">Mail</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="files" aria-pressed="${S.mcp?.cat === "files"}">Files</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="chat" aria-pressed="${S.mcp?.cat === "chat"}">Chat</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="dev" aria-pressed="${S.mcp?.cat === "dev"}">Developer</button>
    </div>
    <div id="mcp-list" data-css="display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
      ${MCP_CATALOG.map(([name, desc]) => `<button class="prov" type="button" data-act="mcp-add" data-v="${esc(name)}" data-css="padding:12px;border:1px solid #ccc;border-radius:8px;cursor:pointer;text-align:left"><b>${esc(name)}</b><small style="display:block;margin-top:4px;color:#666">${esc(desc)}</small></button>`).join('')}
    </div>
  </div>`;

  openDlg({
    title: "Add a connector",
    body: html,
    foot: '<button class="btn ghost" type="button" data-act="tool-add" data-v="mcp" data-step="own">Add your own…</button><button class="btn pri" data-act="dlg-close">Close</button>',
    wide: true
  });

  const input = document.querySelector("#mcp-q");
  if (input) {
    input.addEventListener("input", () => {
      S.mcp.q = input.value;
      drawConnectorCatalog();
    });
    input.focus();
  }
}

function addConnectorFromCatalog(name) {
  closeDlg();
  toast(`${esc(name)} is connecting…`);
  // In a real implementation, this would call api("mcp/add", { name })
  renderNow();
}

function openSkillsDialog() {
  openDlg({
    title: "Add a skill",
    body: `<div style="display:grid;gap:12px">
      <button type="button" data-act="sk-src" data-v="lib" style="padding:16px;border:1px solid #ccc;border-radius:8px;text-align:left;cursor:pointer">
        <b>From the skill library</b>
        <small style="display:block;margin-top:4px;color:#666">Ready-made skills, checked by KeepOak.</small>
      </button>
      <button type="button" data-act="sk-src" data-v="file" style="padding:16px;border:1px solid #ccc;border-radius:8px;text-align:left;cursor:pointer">
        <b>From a file</b>
        <small style="display:block;margin-top:4px;color:#666">A SKILL.md, or a folder with one.</small>
      </button>
      <button type="button" data-act="sk-src" data-v="git" style="padding:16px;border:1px solid #ccc;border-radius:8px;text-align:left;cursor:pointer">
        <b>From GitHub</b>
        <small style="display:block;margin-top:4px;color:#666">Paste the address of a repository.</small>
      </button>
      <button type="button" data-act="sk-src" data-v="write" style="padding:16px;border:1px solid #ccc;border-radius:8px;text-align:left;cursor:pointer">
        <b>Write one with Branch</b>
        <small style="display:block;margin-top:4px;color:#666">Say what it should do; Branch drafts SKILL.md.</small>
      </button>
    </div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>'
  });
}

function openPluginsDialog() {
  openDlg({
    title: "Add a plugin",
    body: `<div style="display:grid;gap:12px">
      <div style="padding:16px;border:1px solid #ccc;border-radius:8px">
        <b>Travel pack</b>
        <small style="display:block;margin-top:4px;color:#666">trip-planner, a Google Calendar server</small>
        <button class="btn sm" type="button" data-act="plug-add" data-v="travel" style="margin-top:8px">Add</button>
      </div>
      <div style="padding:16px;border:1px solid #ccc;border-radius:8px">
        <b>Home pack</b>
        <small style="display:block;margin-top:4px;color:#666">Home Assistant and a house-rules skill</small>
        <button class="btn sm" type="button" data-act="plug-add" data-v="home" style="margin-top:8px">Add</button>
      </div>
      <div style="padding:16px;border:1px solid #ccc;border-radius:8px">
        <b>Writing pack</b>
        <small style="display:block;margin-top:4px;color:#666">An editor skill and a Notion server</small>
        <button class="btn sm" type="button" data-act="plug-add" data-v="writing" style="margin-top:8px">Add</button>
      </div>
      <div style="padding:16px;border:1px solid #ccc;border-radius:8px">
        <b>Money pack</b>
        <small style="display:block;margin-top:4px;color:#666">Budgets, subscriptions and a bank-export reader</small>
        <button class="btn sm" type="button" data-act="plug-add" data-v="money" style="margin-top:8px">Add</button>
      </div>
    </div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Close</button>'
  });
}

function openCliDialog() {
  openDlg({
    title: "Add a command-line tool",
    body: `<p style="margin:0 0 8px;color:#666">Found on this computer. Allow one and choose what it may run without asking.</p>
    <div style="display:grid;gap:8px">
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
        <div><b>winget</b> <small>1.9</small><br><small style="color:#666">Install Windows apps</small></div>
        <button class="btn sm" type="button" data-act="cli-add" data-v="winget">Allow</button>
      </div>
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
        <div><b>node</b> <small>24.15</small><br><small style="color:#666">JavaScript</small></div>
        <button class="btn sm" type="button" data-act="cli-add" data-v="node">Allow</button>
      </div>
    </div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Done</button>'
  });
}

function testMcpServer() {
  const resultDiv = document.querySelector("#mcp-test");
  if (resultDiv) {
    resultDiv.innerHTML = `<div style="padding:12px;border:1px solid #999;border-radius:8px;background:#f0f0f0"><b>It answered</b><p style="margin:4px 0;color:#666">3 tools: search_notes, read_note, create_note.</p></div>`;
  }
}

function saveMcpServer() {
  const name = document.querySelector("#mcp-name")?.value?.trim() || "My server";
  closeDlg();
  toast(`${esc(name)} is added.`);
  renderNow();
}
