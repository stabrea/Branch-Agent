/* Adding a tool, from Customize › Tools (design doc 5.7, the prototype's toolAdd): a connector, a skill or another agent.
   The engine keeps no connector catalog, so the catalog dialog lists none and offers your own server. Its Test and
   Add server stay greyed: trying a server starts the typed program (POST /api/mcp/try), and nothing saves one yet.
   A skill from a file is real: the SKILL.md is read here and sent to POST /api/skills/install. The skill library,
   GitHub and writing one with Branch stay greyed, as do all three ways of connecting another agent (a card address
   this engine can reach, pairing, and a KeepOak computer). */

import { $, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic } from "../core/ui.js";
import { refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { showTool } from "../places/customize.js";

const prov = (act, v, icon, name, sub) => `<button class="prov" type="button" data-act="${act}" data-v="${v}">${icon}<b>${name}</b><small>${sub}</small></button>`;
const tile = (name) => `<span class="ico-tile">${ic(name, "s")}</span>`;

function connectorCatalog() {
  openDlg({ title: "Add a connector", wide: true,
    body: '<div class="aa-list12"><p class="empty">Nothing matches. Add your own server below.</p></div>',
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn" type="button" data-act="t9-own">Add your own server</button>' });
}

function ownServer() {
  const how = ["A command on this computer", "A web address"].map((o) => `<button type="button" data-act="seg" aria-pressed="false">${o}</button>`).join("");
  openDlg({ title: "Add your own MCP server",
    body: `<div class="fld"><span>How it runs</span><span class="seg">${how}</span></div><label class="fld"><span>Name</span><input class="inp" id="mcp-name"></label><label class="fld"><span>Command or address</span><input class="inp code6" id="mcp-cmd" data-css="height:34px"></label><label class="fld"><span>Secrets it needs</span><input class="inp" id="mcp-secrets"></label><div id="mcp-test"></div>`,
    foot: '<button class="btn" type="button" data-act="mcp-test">Test it</button><button class="btn pri" type="button" data-act="mcp-save">Add server</button>' });
}

function addSkill() {
  openDlg({ title: "Add a skill",
    body: `<div class="provs">${prov("sk-lib", "lib", tile("book"), "From the skill library", "Ready-made skills, checked by KeepOak.")}${prov("sk-src", "file", tile("doc"), "From a file", "A SKILL.md, or a folder with one.")}${prov("sk-git", "git", logo("github", "GitHub", 32), "From GitHub", "Paste the address of a repository.")}${prov("sk-write", "write", tile("spark"), "Write one with Branch", "Say what it should do; Branch drafts SKILL.md.")}</div><input type="file" id="sk-file" accept=".md,text/markdown,text/plain" hidden>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>' });
}

function connectAgent() {
  openDlg({ title: "Connect another agent",
    body: `<div class="provs">${prov("ag-add", "card", tile("globe"), "An agent with an A2A card", "Paste its address. Branch reads what it can do.")}${prov("ag-pair", "pair", tile("monitor"), "Branch on another computer", "Pair → Let it in → Name it → What it may do, with a check code.")}${prov("ag-ko", "ko", tile("layers"), "An agent on your KeepOak computer", "Hermes Agent, OpenClaw or another Branch.")}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>' });
}

/* The SKILL.md is sent as it is; the engine checks it, scans it and answers with the installed skill or its reason. */
async function installFile(file) {
  if (!file) return;
  try {
    const skill = await api("skills/install", { document: await file.text() });
    closeDlg();
    await refresh();
    showTool("skills", skill.id);
    renderNow();
    toast("Skill added.");
  } catch (error) { toast(error.message); }
}

const ADD = { mcp: connectorCatalog, skills: addSkill, agents: connectAgent };

export function init() {
  markLive(["tool-add", "t9-own", "sk-src", "sw:sk-file"]);
  /* A plugin or a command-line tool has no add form the engine backs yet: the button opens that kind in Customize. */
  on("tool-add", (el) => { if (ADD[el.dataset.v]) ADD[el.dataset.v](); else { closePop(); showTool(el.dataset.v, null); renderNow(); } });
  on("t9-own", () => ownServer());
  on("sk-src", () => $("#sk-file")?.click());
  document.addEventListener("change", (e) => { if (e.target.id === "sk-file") installFile(e.target.files?.[0]); });
}
