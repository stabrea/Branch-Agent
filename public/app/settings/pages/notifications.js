/* Settings › notifications: bind real engine data and wire controls. */
import { level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render } from "../../core/dom.js";
import { toast } from "../../core/ui.js";

let notifySettings = {
  method: "system",
  sound: "off",
  autoUpdate: "off",
  releaseChannel: "stable"
};

async function loadNotifySettings() {
  try {
    const comfort = await api("comfort");
    notifySettings = comfort.values?.notify || notifySettings;
  } catch (err) {
    console.error("Failed to load notification settings:", err);
  }
  render();
}

async function saveNotifySettings(updates) {
  try {
    const merged = { ...notifySettings, ...updates };
    await api("comfort", { card: "notify", values: merged });
    notifySettings = merged;
    render();
  } catch (err) {
    toast(err.message || "Failed to save notification settings");
    render();
  }
}

export function draw() {
  const html = `<h1>Notifications</h1><p class="lede">When Branch may interrupt you.</p><div class="status"><span class="sdot "></span><div><b>Quiet hours are 10 PM to 7 AM</b><p>Approvals still wait in the Inbox; nothing pings you in that window.</p></div></div>
    <div class="sec"><h2>Tell me when…</h2><div class="ctl"><b>Notifications</b><span class="right"><span class="seg" role="group" aria-label="Notifications"><button type="button" aria-pressed="${notifySettings.method === "window" ? 'true' : 'false'}" data-act="n-method" data-v="window">In the app</button><button type="button" aria-pressed="${notifySettings.method === "system" ? 'true' : 'false'}" data-act="n-method" data-v="system">And on the computer</button></span></span><small>In the app only, or also as system notifications.</small></div><div class="ctl"><b>Play a sound</b><span class="right"><span class="seg" role="group" aria-label="Play a sound"><button type="button" aria-pressed="${notifySettings.sound === "off" ? 'true' : 'false'}" data-act="n-sound" data-v="off">No</button><button type="button" aria-pressed="${notifySettings.sound === "chime" ? 'true' : 'false'}" data-act="n-sound" data-v="chime">A chime</button><button type="button" aria-pressed="${notifySettings.sound === "knock" ? 'true' : 'false'}" data-act="n-sound" data-v="knock">A knock</button></span></span><small>When Branch needs your attention.</small></div></div>
    <div class="sec"><h2>Updates</h2><div class="ctl"><b>Check for updates</b><span class="right"><span class="seg" role="group" aria-label="Check for updates"><button type="button" aria-pressed="${notifySettings.autoUpdate === "off" ? 'true' : 'false'}" data-act="n-update" data-v="off">Never</button><button type="button" aria-pressed="${notifySettings.autoUpdate === "check" ? 'true' : 'false'}" data-act="n-update" data-v="check">Daily</button><button type="button" aria-pressed="${notifySettings.autoUpdate === "install" ? 'true' : 'false'}" data-act="n-update" data-v="install">Install when idle</button></span></span><small>Stable releases keep things working; Beta brings new features first.</small></div><div class="ctl"><b>Release channel</b><span class="right"><span class="seg" role="group" aria-label="Release channel"><button type="button" aria-pressed="${notifySettings.releaseChannel === "stable" ? 'true' : 'false'}" data-act="n-channel" data-v="stable">Stable</button><button type="button" aria-pressed="${notifySettings.releaseChannel === "beta" ? 'true' : 'false'}" data-act="n-channel" data-v="beta">Beta</button><button type="button" aria-pressed="${notifySettings.releaseChannel === "dev" ? 'true' : 'false'}" data-act="n-channel" data-v="dev">Dev</button></span></span><small></small></div></div>`;

  return html;
}

export function init() {
  loadNotifySettings();

  on("n-method", (el) => {
    const value = el.dataset.v;
    saveNotifySettings({ method: value });
  });

  on("n-sound", (el) => {
    const value = el.dataset.v;
    saveNotifySettings({ sound: value });
  });

  on("n-update", (el) => {
    const value = el.dataset.v;
    saveNotifySettings({ autoUpdate: value });
  });

  on("n-channel", (el) => {
    const value = el.dataset.v;
    saveNotifySettings({ releaseChannel: value });
  });

  markLive(["n-method", "n-sound", "n-update", "n-channel"]);
}

export const live = {
  "n-method": true,
  "n-sound": true,
  "n-update": true,
  "n-channel": true,
};
