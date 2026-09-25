import { esc } from "../../core/dom.js";
import { ctl, statusBox } from "../parts.js";

export function draw() {
  return `<h1>Notifications</h1>
    <p class="lede">When Branch may interrupt you.</p>
    ${statusBox("Quiet hours are 10 PM to 7 AM", "Approvals still wait in the Inbox; nothing pings you in that window.")}
    <div class="sec"><h2>Tell me when…</h2>
      ${ctl("n-need", "A Trunk needs a yes", "Shows on this computer and your phone.", true)}
      ${ctl("n-done", "A long task finishes", "Only tasks over two minutes.", true)}
      ${ctl("n-sound", "Play a sound", "A short soft chime.", false)}
    </div>
    <div class="sec"><h2>Quiet</h2>
      <div class="ctl"><b>Days off</b><span class="right"><span class="seg" role="group" aria-label="Days off">${["Sat", "Sun", "None"]
        .map(d => `<button type="button" aria-pressed="${d === "Sun"}">${esc(d)}</button>`)
        .join("")}</span></span><small>No notifications at all on these days.</small></div>
    </div>`;
}

export function init() {}
