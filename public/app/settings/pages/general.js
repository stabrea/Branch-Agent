import { esc } from "../../core/dom.js";
import { ic } from "../../core/ui.js";
import { ctl } from "../parts.js";

export function draw() {
  return `<h1>General</h1>
    <p class="lede">How Branch starts and behaves on this computer.</p>
    <div class="sec"><h2>Starting up</h2>
      ${ctl("g-start", "Start with Windows", "Opens quietly in the tray.", true)}
      ${ctl("g-tray", "Keep working when the window closes", "Trunks finish what they started.", true)}
    </div>
    <div class="sec"><h2>Keyboard</h2>
      <div class="ctl"><b>Keyboard shortcuts</b><span class="right"><button class="btn sm" type="button" data-act="toast" data-msg="Ctrl K to find anything, Ctrl N for a new conversation.">Show all</button></span><small>Ctrl K to find anything, Ctrl N for a new conversation.</small></div>
    </div>`;
}

export function init() {}
