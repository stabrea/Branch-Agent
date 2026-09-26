/* Settings › General, 1:1 with the prototype's page. Whether Branch starts with Windows and keeps working with the
   window closed are the engine's (GET /api/deployment autostart, daemon), shown and greyed: changing them changes this
   computer's own start-up. The projects are the engine's (GET /api/projects answers { active, all }); every other
   row is drawn in place and greyed until its engine setting is wired. */
import { esc, renderNow } from "../../core/dom.js";
import { level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { ctl, ctlSeg } from "../parts.js";

let projects = [];
let deployment = null;

async function loadProjects() {
  try {
    const [p, d] = await Promise.all([api("projects"), api("deployment")]);
    projects = p.all ?? [];
    deployment = d;
  } catch (error) { toast(error.message); }
  renderNow();
}

const FOLDER = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"></path></svg>';
const project = (p) => `<div class="prow"><span class="ico-tile">${FOLDER}</span><span class="grow"><b>${esc(p.name)}</b><small>${p.instructions ? "its own instructions" : ""}</small></span><button class="btn sm" type="button" data-act="toast" data-msg="Edit this project’s instructions.">Edit</button></div>`;
const num = (id, title, sub, unit) => `<div class="ctl"><b>${esc(title)}</b><span class="right num15"><input class="inp" id="${id}" aria-label="${esc(title)}" data-sw="set"><small>${esc(unit)}</small></span><small>${esc(sub)}</small></div>`;

function advanced() {
  return `<div class="sec x15-sec"><h2>The conversation</h2>${ctl("f15-vim-keys-in-the-message-box", "Vim keys in the message box", "Normal and insert modes, for people who type that way.", false)}${ctlSeg("Message times", "When a message was sent, and when a task started and ended.", ["On hover", "Always", "Never"], "")}</div>
    <div class="sec x15-sec"><h2>Summaries of older turns</h2>${ctl("f15-summarise-older-turns-by-themselves", "Summarise older turns by themselves", "Keeps long conversations fast. The summary card shows what was kept.", false)}${num("f15-summarise-when", "Summarise when it’s this full", "Of the model’s room for this conversation.", "%")}${num("f15-keep-latest", "Always keep the latest", "Messages kept word for word.", "messages")}</div>`;
}

function technical() {
  return `<div class="sec x15-sec"><h2>Summaries, technical</h2>${ctlSeg("Room to plan for", "Overrides what the model says it can hold.", ["Model’s own", "128k", "200k", "1M"], "")}${ctl("f15-repair-the-history-before-each-call", "Repair the history before each call", "Fixes a broken tool call or a half-written answer before the model sees it.", false)}</div>`;
}

export function draw() {
  const lv = level(), starts = !!deployment?.autostart?.enabled;
  return `<h1>General</h1><p class="lede">How Branch starts and behaves on this computer.</p>
    ${starts ? '<div class="status"><span class="sdot "></span><div><b>Branch starts with Windows</b><p>It waits in the tray and keeps scheduled work running when the window is closed.</p></div></div>' : ""}
    <div class="sec"><h2>Starting up</h2>${ctl("g-start", "Start with Windows", "Opens quietly in the tray.", starts)}${ctl("g-tray", "Keep working when the window closes", "Trunks finish what they started.", !!deployment?.daemon?.installed)}</div>
    <div class="sec"><h2>Projects</h2><div class="rows">${projects.map(project).join("")}</div></div>
    <div class="sec"><h2>Keyboard</h2><div class="ctl"><b>Keyboard shortcuts</b><span class="right"><button class="btn sm" type="button" data-act="shortcuts">Show all</button></span><small>Ctrl K to find anything, Ctrl N for a new conversation.</small></div></div>
    ${lv >= 1 ? advanced() : ""}${lv >= 2 ? technical() : ""}`;
}

export function init() { loadProjects(); }

export function load() { return loadProjects(); }

export const live = {};
