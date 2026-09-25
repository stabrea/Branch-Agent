/* Settings › general: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { renderNow } from "../../core/dom.js";

let projects = [];

async function loadProjects() {
  try {
    const data = await api("projects");
    projects = data || [];
  } catch (err) {
    console.error("Failed to load projects:", err);
    projects = [];
  }
  renderNow();
}

export function draw() {
  const lv = level();

  let html = "<h1>General</h1><p class=\"lede\">How Branch starts and behaves on this computer.</p>";
  html += "<div class=\"status\"><span class=\"sdot \"></span><div><b>Branch starts with Windows</b><p>It waits in the tray and keeps scheduled work running when the window is closed.</p></div></div>";
  html += "<div class=\"sec\"><h2>Starting up</h2>";
  html += "<div class=\"ctl\"><b>Start with Windows</b><input class=\"sw\" type=\"checkbox\" id=\"g-start\" checked aria-label=\"Start with Windows\" data-sw=\"set\"><small>Opens quietly in the tray.</small></div>";
  html += "<div class=\"ctl\"><b>Keep working when the window closes</b><input class=\"sw\" type=\"checkbox\" id=\"g-tray\" checked aria-label=\"Keep working when the window closes\" data-sw=\"set\"><small>Trunks finish what they started.</small></div>";
  html += "</div>";

  html += "<div class=\"sec\"><h2>Projects</h2><div class=\"rows\">";
  if (projects && projects.length > 0) {
    for (const proj of projects) {
      const cnt = proj.conversationCount || 0;
      const inst = proj.hasInstructions ? " · its own instructions" : "";
      html += "<div class=\"prow\"><span class=\"ico-tile\"><svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z\"></path></svg></span><span class=\"grow\"><b>" + esc(proj.name) + "</b><small>" + cnt + " conversation" + (cnt !== 1 ? "s" : "") + inst + "</small></span><button class=\"btn sm\" type=\"button\" data-act=\"toast\" data-msg=\"Edit this project's instructions.\">Edit</button></div>";
    }
  }
  html += "</div></div>";

  html += "<div class=\"sec\"><h2>Keyboard</h2>";
  html += "<div class=\"ctl\"><b>Keyboard shortcuts</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"shortcuts\">Show all</button></span><small>Ctrl K to find anything, Ctrl N for a new conversation.</small></div>";
  html += "</div>";

  if (lv >= 1) {
    html += "<div class=\"sec x15-sec\"><h2>The conversation</h2>";
    html += "<div class=\"ctl\"><b>Vim keys in the message box</b><input class=\"sw\" type=\"checkbox\" id=\"f15-vim-keys-in-the-message-box\" aria-label=\"Vim keys in the message box\" data-sw=\"set\"><small>Normal and insert modes, for people who type that way.</small></div>";
    html += "<div class=\"ctl\"><b>Message times</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Message times\"><button type=\"button\" aria-pressed=\"true\" data-act=\"seg\">On hover</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Always</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Never</button></span></span><small>When a message was sent, and when a task started and ended.</small></div>";
    html += "</div>";
    html += "<div class=\"sec x15-sec\"><h2>Summaries of older turns</h2>";
    html += "<div class=\"ctl\"><b>Summarise older turns by themselves</b><input class=\"sw\" type=\"checkbox\" id=\"f15-summarise-older-turns-by-themselves\" checked aria-label=\"Summarise older turns by themselves\" data-sw=\"set\"><small>Keeps long conversations fast. The summary card shows what was kept.</small></div>";
    html += "<div class=\"ctl\"><b>Summarise when it's this full</b><span class=\"right num15\"><input class=\"inp\" value=\"80\" aria-label=\"Summarise when it's this full\"><small>%</small></span><small>Of the model's room for this conversation.</small></div>";
    html += "<div class=\"ctl\"><b>Always keep the latest</b><span class=\"right num15\"><input class=\"inp\" value=\"20\" aria-label=\"Always keep the latest\"><small>messages</small></span><small>Messages kept word for word.</small></div>";
    html += "</div>";
  }

  if (lv >= 2) {
    html += "<div class=\"sec x15-sec\"><h2>Summaries, technical</h2>";
    html += "<div class=\"ctl\"><b>Room to plan for</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Room to plan for\"><button type=\"button\" aria-pressed=\"true\" data-act=\"seg\">Model's own</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">128k</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">200k</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">1M</button></span></span><small>Overrides what the model says it can hold.</small></div>";
    html += "<div class=\"ctl\"><b>Repair the history before each call</b><input class=\"sw\" type=\"checkbox\" id=\"f15-repair-the-history-before-each-call\" checked aria-label=\"Repair the history before each call\" data-sw=\"set\"><small>Fixes a broken tool call or a half-written answer before the model sees it.</small></div>";
    html += "</div>";
  }

  return html;
}

export function init() {
  loadProjects();
}

export async function load() {
  await loadProjects();
}

export const live = {
  // No controls wired yet
};
