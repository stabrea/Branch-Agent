/* Settings › voice: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render } from "../../core/dom.js";
import { toast } from "../../core/ui.js";

let voiceSettings = {
  autoReadAloud: false,
  voiceId: "default",
  systemVoice: "off",
  keepAudioOnThisComputer: false,
};

let comfortVoice = {
  pushToTalkKey: "",
  maxRecordingSeconds: null,
};

async function loadVoiceSettings() {
  try {
    const [v, c] = await Promise.all([
      api("voice/settings"),
      api("comfort").then(r => r.values?.voice || comfortVoice),
    ]);
    voiceSettings = v || voiceSettings;
    comfortVoice = c || comfortVoice;
  } catch (err) {
    console.error("Failed to load voice settings:", err);
  }
  render();
}

async function saveVoiceSettings(updates) {
  try {
    const merged = { ...voiceSettings, ...updates };
    await api("voice/settings", merged);
    voiceSettings = merged;
    render();
  } catch (err) {
    toast(err.message || "Failed to save voice settings");
    render();
  }
}

async function saveComfortVoice(updates) {
  try {
    const merged = { ...comfortVoice, ...updates };
    await api("comfort", { card: "voice", values: merged });
    comfortVoice = merged;
    render();
  } catch (err) {
    toast(err.message || "Failed to save voice comfort settings");
    render();
  }
}

export function draw() {
  const lv = level();

  let html = `<h1>Voice</h1><p class="lede">Talking to Branch. Voice stays on this computer.</p>`;
  html += `<div class="sec"><h2>Talking</h2>`;
  html += `<div class="ctl"><b>System voice</b><span class="right"><span class="seg" role="group" aria-label="System voice">`;
  html += `<button type="button" aria-pressed="${voiceSettings.systemVoice === 'off' ? 'true' : 'false'}" data-act="sys-voice" data-v="off">Off</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.systemVoice === 'on' ? 'true' : 'false'}" data-act="sys-voice" data-v="on">On</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.systemVoice === 'auto' ? 'true' : 'false'}" data-act="sys-voice" data-v="auto">Auto</button>`;
  html += `</span></span><small>Use the computer's own voice for speaking. On only when you ask, since it keeps the microphone open.</small></div>`;
  html += `<div class="ctl"><b>Keep audio on this computer</b><input class="sw" type="checkbox" id="v-local" ${voiceSettings.keepAudioOnThisComputer ? 'checked' : ''} aria-label="Keep audio on this computer" data-sw="set"><small>Nothing with sound leaves this computer; cloud routes refuse instead.</small></div>`;
  html += `</div>`;

  html += `<div class="sec"><h2>Speaking back</h2>`;
  html += `<div class="ctl"><b>Read replies aloud</b><span class="right"><span class="seg" role="group" aria-label="Read replies aloud">`;
  html += `<button type="button" aria-pressed="${!voiceSettings.autoReadAloud ? 'true' : 'false'}" data-act="auto-read" data-v="false">No</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.autoReadAloud ? 'true' : 'false'}" data-act="auto-read" data-v="true">Yes</button>`;
  html += `</span></span><small>Read every reply, or ask first.</small></div>`;
  html += `</div>`;

  // Advanced sections
  if (lv >= 1) {
    html += `<div class="sec x15-sec"><h2>Live conversations</h2>`;
    html += `<div class="ctl"><b>Max duration</b><span class="right num15"><input class="inp" value="10" aria-label="Max duration" disabled><small>minutes</small></span><small>A live conversation stops itself after this many minutes.</small></div>`;
    html += `<div class="ctl"><b>Max cost</b><span class="right num15"><input class="inp" value="1" aria-label="Max cost" disabled><small>USD</small></span><small>Stops once it has cost this much.</small></div>`;
    html += `<div class="ctl"><b>Voice detection</b><input class="sw" type="checkbox" id="f15-voice-detect" aria-label="Voice detection" data-sw="set" disabled><small>Let the service decide when you have stopped speaking, rather than pressing the button.</small></div>`;
    html += `</div>`;
  }

  return html;
}

export function init() {
  loadVoiceSettings();

  on("sys-voice", (el) => {
    const value = el.dataset.v;
    saveVoiceSettings({ systemVoice: value });
  });

  on("auto-read", (el) => {
    const value = el.dataset.v === "true";
    saveVoiceSettings({ autoReadAloud: value });
  });

  markLive(["sys-voice", "auto-read"]);
}

export async function load() {
  await loadVoiceSettings();
}

export const live = {
  "sys-voice": true,
  "auto-read": true,
};

export function after(col) {
  // Set up control listeners after rendering
}
