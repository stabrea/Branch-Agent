/* Settings › voice: bind real engine data and wire controls. */
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";

let voiceSettings = null;

async function loadVoiceSettings() {
  try {
    const data = await api("voice/settings");
    voiceSettings = data;
  } catch (err) {
    console.error("Failed to load voice settings:", err);
    voiceSettings = { listening: 'push-to-talk', voice: 'Oak', dictation: true };
  }
}

function draw() {
  if (!voiceSettings) {
    voiceSettings = { listening: 'push-to-talk', voice: 'Oak', dictation: true };
  }

  const lv = level();

  let html = `<h1>Voice</h1><p class="lede">Talking to Branch. Voice stays on this computer.</p>`;
  html += `<div class="sec"><h2>Talking</h2>`;
  html += `<div class="ctl"><b>Listening</b><span class="right"><span class="seg" role="group" aria-label="Listening">`;
  html += `<button type="button" aria-pressed="${voiceSettings.listening === 'off' ? 'true' : 'false'}" data-act="seg">Off</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.listening === 'push-to-talk' ? 'true' : 'false'}" data-act="seg">Push to talk</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.listening === 'wake-word' ? 'true' : 'false'}" data-act="seg">Wake word</button>`;
  html += `</span></span><small>Push to talk holds the key; wake word listens for "Hey Branch".</small></div>`;
  html += `<div class="ctl"><b>Push-to-talk key</b><span class="right"><kbd data-css="font-size:12px;padding:4px 8px">Right Ctrl</kbd><button class="btn sm" type="button" data-act="toast" data-msg="Press the key you want to use.">Change</button></span><small>Hold it anywhere in Windows.</small></div>`;
  html += `</div>`;

  html += `<div class="sec"><h2>Speaking back</h2>`;
  html += `<div class="ctl"><b>Voice</b><span class="right"><span class="seg" role="group" aria-label="Voice">`;
  html += `<button type="button" aria-pressed="${voiceSettings.voice === 'Oak' ? 'true' : 'false'}" data-act="seg">Oak</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.voice === 'Birch' ? 'true' : 'false'}" data-act="seg">Birch</button>`;
  html += `<button type="button" aria-pressed="${voiceSettings.voice === 'Off' ? 'true' : 'false'}" data-act="seg">Off</button>`;
  html += `</span></span><small>Read replies out loud in this voice.</small></div>`;
  html += `<div class="ctl"><b>Dictation in the message box</b><input class="sw" type="checkbox" id="v-dict" ${voiceSettings.dictation ? 'checked' : ''} aria-label="Dictation in the message box" data-sw="set"><small>The microphone button turns speech into text.</small></div>`;
  html += `</div>`;

  // Advanced sections
  if (lv >= 1) {
    html += `<div class="sec x15-sec"><h2>Listening, more</h2>`;
    html += `<div class="ctl"><b>Wake word</b><input class="sw" type="checkbox" id="f15-wake-word" aria-label="Wake word" data-sw="set"><small>"Hey Branch", heard on this computer only. Off until you choose: it keeps the microphone open.</small></div>`;
    html += `<div class="ctl"><b>Stop listening after silence</b><span class="right num15"><input class="inp" value="1.5" aria-label="Stop listening after silence"><small>s</small></span><small>For live dictation.</small></div>`;
    html += `<div class="ctl"><b>Answer aloud</b><span class="right"><span class="seg" role="group" aria-label="Answer aloud">`;
    html += `<button type="button" aria-pressed="false" data-act="seg">Never</button>`;
    html += `<button type="button" aria-pressed="true" data-act="seg">When I talk</button>`;
    html += `<button type="button" aria-pressed="false" data-act="seg">Always</button>`;
    html += `</span></span><small></small></div>`;
    html += `<div class="ctl"><b>Spoken morning brief</b><input class="sw" type="checkbox" id="f15-spoken-morning-brief" aria-label="Spoken morning brief" data-sw="set"><small>The written brief, read out at 7:30 on the speaker you choose.</small></div>`;
    html += `</div>`;
  }

  return html;
}

export async function load() {
  await loadVoiceSettings();
}

export function init() {
  // Set up event handlers
}

export const live = {
  // Wire up these controls
};

export function after(col) {
  // Set up control listeners after rendering
}
