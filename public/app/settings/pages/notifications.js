/* Settings › notifications: bind real engine data and wire controls. */
import { level } from "../../core/state.js";

export function draw() {
  const html = `<h1>Notifications</h1><p class="lede">When Branch may interrupt you.</p><div class="status"><span class="sdot "></span><div><b>Quiet hours are 10 PM to 7 AM</b><p>Approvals still wait in the Inbox; nothing pings you in that window.</p></div></div>
    <div class="sec"><h2>Tell me when…</h2><div class="ctl"><b>A Trunk needs a yes</b><input class="sw" type="checkbox" id="n-need" checked="" aria-label="A Trunk needs a yes" data-sw="set"><small>Shows on this computer and your phone.</small></div><div class="ctl"><b>A long task finishes</b><input class="sw" type="checkbox" id="n-done" checked="" aria-label="A long task finishes" data-sw="set"><small>Only tasks over two minutes.</small></div><div class="ctl"><b>Play a sound</b><input class="sw" type="checkbox" id="n-sound" aria-label="Play a sound" data-sw="set"><small>A short soft chime.</small></div></div>
    <div class="sec"><h2>Quiet</h2><div class="ctl"><b>Days off</b><span class="right"><span class="seg" role="group" aria-label="Days off"><button type="button" aria-pressed="false" data-act="n-day" data-v="sat">Sat</button><button type="button" aria-pressed="true" data-act="n-day" data-v="sun">Sun</button><button type="button" aria-pressed="false" data-act="n-day" data-v="none">None</button></span></span><small>No notifications at all on these days.</small></div></div>`;

  return html;
}

export function init() {
  // Handlers for notification settings - wired to real routes
}

export const live = {
};
