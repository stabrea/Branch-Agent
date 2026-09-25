/* Terminal pane (A.16): shows terminal output in the side pane.
   Window state: which place the terminal is on (S.terminalPlace), which chat/conversation (S.terminalChat). */

import { $, esc, render, onRender } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

S.terminalPlace ??= 0;
S.terminalChat ??= null;

export function initTerminal() {
  markLive(["t-place", "t-sel"]);
  onRender(drawTerminal);

  on("t-place", (el) => {
    const index = parseInt(el.dataset.i || "0", 10);
    S.terminalPlace = index;
    render();
  });

  on("t-sel", (el) => {
    const chatId = el.dataset.id;
    S.terminalChat = S.terminalChat === chatId ? null : chatId;
    render();
  });
}

/* Render terminal pane body */
export function drawTerminal() {
  const body = $(".pane-b");
  if (!body || S.pane !== "terminal") return;
  body.innerHTML = terminalHtml();
}

function terminalHtml() {
  const places = ["Overview", "Inbox", "Library", "Automations", "Customize"];
  const current = places[S.terminalPlace] || "Terminal";

  return `
    <div class="pane-tabs">
      ${places.map((p, i) => `
        <button type="button" class="ptab" data-act="t-place" data-i="${i}" aria-selected="${S.terminalPlace === i}">
          ${esc(p)}
        </button>
      `).join("")}
    </div>
    <div class="shell">
      <div class="shell-out">$ latest output from "${esc(current)}"</div>
      <form>
        <span>$ </span>
        <input type="text" placeholder="command..." />
      </form>
    </div>
  `;
}
