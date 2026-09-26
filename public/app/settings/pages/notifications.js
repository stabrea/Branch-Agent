/* Settings › Notifications, 1:1 with the prototype's page, from the engine: how Branch gets your attention and whether
   it updates itself (the comfort card "notify", POST /api/comfort { card, values }, merged), and quiet hours
   (GET /api/calendar), named in the status line only while they are on. "A Trunk needs a yes", "A long task finishes"
   and "Days off" have no engine setting of their own (the engine's working days are a set, not one day), so they are
   drawn greyed. */
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { toast } from "../../core/ui.js";
import { ctl, ctlSeg } from "../parts.js";

let notify = null;
let quiet = null;

async function loadNotify() {
  try {
    const [comfort, calendar] = await Promise.all([api("comfort"), api("calendar")]);
    notify = comfort.values?.notify ?? null;
    quiet = calendar.settings?.quietHours ?? null;
  } catch (error) { toast(error.message); }
  render();
}

async function saveNotify(part) {
  try { notify = (await api("comfort", { card: "notify", values: part })).values?.notify ?? notify; } catch (error) { toast(error.message); }
  render();
}

const seg = (title, sub, act, opts, cur) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${v}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

/* "21:00" as the prototype says it ("10 PM"), in this computer's own way of writing a time. */
const clock = (hm) => { const [h, m] = String(hm).split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: m ? "2-digit" : undefined }); };
const status = () => (quiet?.enabled ? `<div class="status"><span class="sdot "></span><div><b>Quiet hours are ${esc(clock(quiet.from))} to ${esc(clock(quiet.to))}</b><p>Approvals still wait in the Inbox; nothing pings you in that window.</p></div></div>` : "");

export function draw() {
  const n = notify ?? {};
  return `<h1>Notifications</h1><p class="lede">When Branch may interrupt you.</p>${status()}
    <div class="sec"><h2>Tell me when…</h2>${ctl("n-need", "A Trunk needs a yes", "Shows on this computer and your phone.", false)}${ctl("n-done", "A long task finishes", "Only tasks over two minutes.", false)}
      ${seg("Notifications", "In the app only, or also as system notifications.", "n-method", [["window", "In the app"], ["system", "And on the computer"]], n.method)}
      ${seg("Play a sound", "When Branch needs your attention.", "n-sound", [["off", "No"], ["chime", "A chime"], ["knock", "A knock"]], n.sound)}</div>
    <div class="sec"><h2>Quiet</h2>${ctlSeg("Days off", "No notifications at all on these days.", ["Sat", "Sun", "None"], "")}</div>
    <div class="sec"><h2>Updates</h2>${seg("Check for updates", "Stable releases keep things working; Beta brings new features first.", "n-update", [["off", "Never"], ["check", "Daily"], ["install", "Install when idle"]], n.autoUpdate)}
      ${seg("Release channel", "", "n-channel", [["stable", "Stable"], ["beta", "Beta"], ["dev", "Dev"]], n.releaseChannel)}</div>`;
}

export function init() {
  loadNotify();
  on("n-method", (el) => saveNotify({ method: el.dataset.v }));
  on("n-sound", (el) => saveNotify({ sound: el.dataset.v }));
  on("n-update", (el) => saveNotify({ autoUpdate: el.dataset.v }));
  on("n-channel", (el) => saveNotify({ releaseChannel: el.dataset.v }));
  markLive(["n-method", "n-sound", "n-update", "n-channel"]);
}

export function load() { return loadNotify(); }

export const live = { "n-method": true, "n-sound": true, "n-update": true, "n-channel": true };
