/* Settings › general: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";

let projects = null;

async function loadProjects() {
  try {
    const data = await api("projects");
    projects = data || [];
  } catch (err) {
    console.error("Failed to load projects:", err);
    projects = [];
  }
}

export function draw() {
  const lv = level();

  let html = `<h1>General</h1><p class="lede">How Branch starts and behaves on this computer.</p><div class="status"><span class="sdot "></span><div><b>Branch starts with Windows</b><p>It waits in the tray and keeps scheduled work running when the window is closed.</p></div></div>
    <div class="sec"><h2>Starting up</h2><div class="ctl"><b>Start with Windows</b><input class="sw" type="checkbox" id="g-start" checked="" aria-label="Start with Windows" data-sw="set"><small>Opens quietly in the tray.</small></div><div class="ctl"><b>Keep working when the window closes</b><input class="sw" type="checkbox" id="g-tray" checked="" aria-label="Keep working when the window closes" data-sw="set"><small>Trunks finish what they started.</small></div></div>
    <div class="sec"><h2>Projects</h2><div class="rows">`;

  if (projects && projects.length > 0) {
    for (const project of projects) {
      const count = project.conversationCount || 0;
      const hasInstructions = project.hasInstructions ? " · its own instructions" : "";
      html += `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"></path></svg></span><span class="grow"><b>${esc(project.name)}</b><small>${count} conversation${count !== 1 ? "s" : ""}${hasInstructions}</small></span><button class="btn sm" type="button" data-act="g-edit-proj" data-v="${esc(project.id)}">Edit</button></div>`;
    }
  }

  html += `</div></div>
    <div class="sec"><h2>Keyboard</h2><div class="ctl"><b>Keyboard shortcuts</b><span class="right"><button class="btn sm" type="button" data-act="shortcuts">Show all</button></span><small>Ctrl K to find anything, Ctrl N for a new conversation.</small></div></div>`;

  if (lv >= 1) {
    html += `<div class="sec x15-sec"><h2>The conversation</h2><div class="ctl"><b>Vim keys in the message box</b><input class="sw" type="checkbox" id="f15-vim-keys-in-the-message-box" aria-label="Vim keys in the message box" data-sw="set"><small>Normal and insert modes, for people who type that way.</small></div><div class="ctl"><b>Message times</b><span class="right"><span class="seg" role="group" aria-label="Message times"><button type="button" aria-pressed="true" data-act="g-times" data-v="hover">On hover</button><button type="button" aria-pressed="false" data-act="g-times" data-v="always">Always</button><button type="button" aria-pressed="false" data-act="g-times" data-v="never">Never</button></span></span><small>When a message was sent, and when a task started and ended.</small></div></div><div class="sec x15-sec"><h2>Summaries of older turns</h2><div class="ctl"><b>Summarise older turns by themselves</b><input class="sw" type="checkbox" id="f15-summarise-older-turns-by-themselves" checked="" aria-label="Summarise older turns by themselves" data-sw="set"><small>Keeps long conversations fast. The summary card shows what was kept.</small></div><div class="ctl"><b>Summarise when it's this full</b><span class="right num15"><input class="inp" value="80" aria-label="Summarise when it's this full"><small>%</small></span><small>Of the model's room for this conversation.</small></div><div class="ctl"><b>Always keep the latest</b><span class="right num15"><input class="inp" value="20" aria-label="Always keep the latest"><small>messages</small></span><small>Messages kept word for word.</small></div></div>`;
  }

  if (lv >= 2) {
    html += `<div class="sec x15-sec"><h2>Summaries, technical</h2><div class="ctl"><b>Room to plan for</b><span class="right"><span class="seg" role="group" aria-label="Room to plan for"><button type="button" aria-pressed="true" data-act="g-plan" data-v="own">Model's own</button><button type="button" aria-pressed="false" data-act="g-plan" data-v="128k">128k</button><button type="button" aria-pressed="false" data-act="g-plan" data-v="200k">200k</button><button type="button" aria-pressed="false" data-act="g-plan" data-v="1m">1M</button></span></span><small>Overrides what the model says it can hold.</small></div><div class="ctl"><b>Repair the history before each call</b><input class="sw" type="checkbox" id="f15-repair-the-history-before-each-call" checked="" aria-label="Repair the history before each call" data-sw="set"><small>Fixes a broken tool call or a half-written answer before the model sees it.</small></div></div>`;
  }

  return html;
}

export async function load() {
  await loadProjects();
}

export function init() {
  // Handlers for general settings
}

export const live = {
};
