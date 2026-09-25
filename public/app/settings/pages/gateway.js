/* Settings › gateway: bind gateway status and mode from the engine. */
import { level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render } from "../../core/dom.js";

let gwData = null;

async function loadGateway() {
  try {
    gwData = await api("never-break");
    render();
  } catch (e) {
    console.error("Failed to load gateway data:", e);
  }
}

export function init() {
  loadGateway();
  on("gw-mode", (el) => {
    const mode = el.dataset.v;
    api("never-break", { mode }).catch(e => console.error("Failed to set gateway mode:", e));
  });
  markLive(["gw-mode"]);
}

export async function load() {
  await loadGateway();
}

const BASE = `<h1>Gateway</h1><p class="lede">A small helper that keeps Branch running in the background, starts it again if it stops, and carries interrupted work on.</p>`;

function statusSection(gw) {
  const mode = gw?.mode ?? "off";
  const isOn = mode === "on";
  const isWhenNeeded = mode === "when-needed";
  const sdotClass = isOn || isWhenNeeded ? "ok" : "bad";
  const title = isOn ? "The gateway is on" : isWhenNeeded ? "The gateway is when-needed" : "The gateway is off";
  const desc = isOn ? "On. Telegram, your phone and automations keep working when the window is closed, and it restarts the engine if it stops." : isWhenNeeded ? "When needed. It starts when a Trunk or a message needs it, and stops after the last task." : "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.";

  return `<div class="status"><span class="sdot ${sdotClass}"></span><div><b>${title}</b><p>${desc}</p></div></div>`;
}

function modeSection(gw) {
  const mode = gw?.mode ?? "off";
  return `<div class="sec"><h2>Keep Branch running</h2><div class="ctl"><b>Gateway</b><span class="right"><span class="seg" role="group" aria-label="Gateway"><button type="button" aria-pressed="${mode === "off" ? "true" : "false"}" data-act="gw-mode" data-v="off">Off</button><button type="button" aria-pressed="${mode === "when-needed" ? "true" : "false"}" data-act="gw-mode" data-v="when-needed">When needed</button><button type="button" aria-pressed="${mode === "on" ? "true" : "false"}" data-act="gw-mode" data-v="on">On</button></span></span><small>Recommended: On. Telegram, your phone and automations keep working when the window is closed.</small></div></div>`;
}

const ACTIONS = `<div class="acts" data-css="margin-top:16px"><button class="btn" type="button" data-act="gw-restart"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"></path></svg>Restart the engine</button></div>
    <p class="hint">Switch to Technical (bottom left) to see file paths, ports and raw settings.</p>`;

const ADVANCED_EXTRA = `<div class="sec x15-sec"><h2>Chat apps, more</h2><div class="ctl"><b>Pause a chat app from the chat</b><input class="sw" type="checkbox" id="f15-pause-a-chat-app-from-the-chat" checked="" aria-label="Pause a chat app from the chat" data-sw="set"><small>/pause and /resume in that app.</small></div></div><div class="sec x15-sec"><h2>Chat apps, even more</h2><div class="ctl"><b>Send files into chats</b><input class="sw" type="checkbox" id="f15-send-files-into-chats" checked="" aria-label="Send files into chats" data-sw="set"><small>A Trunk can reply with the file itself, not a link.</small></div><div class="ctl"><b>Relay for chat-app accounts</b><input class="sw" type="checkbox" id="f15-relay-for-chat-app-accounts" aria-label="Relay for chat-app accounts" data-sw="set"><small>Your phone number stays with Branch, not the bot service.</small></div><div class="ctl"><b>Push to your phone and browser</b><input class="sw" type="checkbox" id="f15-push-to-your-phone-and-browser" checked="" aria-label="Push to your phone and browser" data-sw="set"><small>When a Trunk needs you and no chat app is set up.</small></div></div>`;

const TECHNICAL_EXTRA = `<div class="sec"><h2>Technical</h2><dl class="kv"><dt>Configuration file</dt><dd>gateway.json</dd></dl></div><div class="sec x15-sec"><h2>Chat apps, more</h2><div class="ctl"><b>Pause a chat app from the chat</b><input class="sw" type="checkbox" id="f15-pause-a-chat-app-from-the-chat" checked="" aria-label="Pause a chat app from the chat" data-sw="set"><small>/pause and /resume in that app.</small></div></div><div class="sec x15-sec"><h2>Chat apps, even more</h2><div class="ctl"><b>Send files into chats</b><input class="sw" type="checkbox" id="f15-send-files-into-chats" checked="" aria-label="Send files into chats" data-sw="set"><small>A Trunk can reply with the file itself, not a link.</small></div><div class="ctl"><b>Relay for chat-app accounts</b><input class="sw" type="checkbox" id="f15-relay-for-chat-app-accounts" aria-label="Relay for chat-app accounts" data-sw="set"><small>Your phone number stays with Branch, not the bot service.</small></div><div class="ctl"><b>Push to your phone and browser</b><input class="sw" type="checkbox" id="f15-push-to-your-phone-and-browser" checked="" aria-label="Push to your phone and browser" data-sw="set"><small>When a Trunk needs you and no chat app is set up.</small></div></div>`;

export function draw() {
  const gw = gwData || {};
  const lev = level();
  const main = BASE + statusSection(gw) + modeSection(gw) + ACTIONS;

  if (lev === 0) return main;
  if (lev === 1) return main + ADVANCED_EXTRA;
  return main + TECHNICAL_EXTRA;
}
