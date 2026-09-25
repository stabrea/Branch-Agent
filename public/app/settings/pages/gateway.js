/* Settings › gateway: bind gateway status and mode from the engine. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";

const BASE = `<h1>Gateway</h1><p class="lede">A small helper that keeps Branch running in the background, starts it again if it stops, and carries interrupted work on.</p>`;

function statusSection(gw) {
  const mode = gw?.mode ?? "off";
  const isOn = mode === "on";
  const isWhenNeeded = mode === "when-needed";
  const sdotClass = isOn || isWhenNeeded ? "ok" : "bad";
  const title = isOn ? "The gateway is on" : isWhenNeeded ? "The gateway is when-needed" : "The gateway is off";
  const desc = isOn ? "On. Telegram, your phone and automations keep working when the window is closed, and it restarts the engine if it stops." : isWhenNeeded ? "When needed. It starts when a Trunk or a message needs it, and stops 5 minutes after the last task." : "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.";

  return `<div class="status"><span class="sdot ${sdotClass}"></span><div><b>${title}</b><p>${desc}</p></div></div>`;
}

function modeSection(gw) {
  const mode = gw?.mode ?? "off";
  return `<div class="sec"><h2>Keep Branch running</h2><div class="ctl"><b>Gateway</b><span class="right"><span class="seg" role="group" aria-label="Gateway"><button type="button" aria-pressed="${mode === "off" ? "true" : "false"}" data-act="gw-mode" data-v="off">Off</button><button type="button" aria-pressed="${mode === "when-needed" ? "true" : "false"}" data-act="gw-mode" data-v="when-needed">When needed</button><button type="button" aria-pressed="${mode === "on" ? "true" : "false"}" data-act="gw-mode" data-v="on">On</button></span></span><small>Recommended: On. Telegram, your phone and automations keep working when the window is closed.</small></div><div class="ctl"><b>Carry on interrupted work by itself</b><input class="sw" type="checkbox" id="gw-carry" ${gw?.carryOn ? "checked" : ""} aria-label="Carry on interrupted work by itself" data-sw="set"><small>After a restart, safe steps carry on. Anything that sends or changes something asks you first.</small></div><div class="ctl"><b>Show the gateway in the tray</b><input class="sw" type="checkbox" id="gw-tray" ${gw?.tray ? "checked" : ""} aria-label="Show the gateway in the tray" data-sw="set"><small>A small Branch icon by the clock with Restart and Quit.</small></div></div>`;
}

const TIMELINE = `<div class="sec"><h2>What it has been doing</h2><ol class="tl"><li class=""><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 11v5.5M12 7.5v.1"></path></svg><span>Nothing is watching Branch<small>The gateway is off, so a stopped engine stays stopped</small></span><time></time></li></ol></div>`;

const ACTIONS = `<div class="acts" data-css="margin-top:16px"><button class="btn" type="button" data-act="gw-restart"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"></path></svg>Restart the engine</button></div>
    <p class="hint">Switch to Technical (bottom left) to see file paths, ports and raw settings.</p>`;

const ADVANCED_EXTRA = `<div class="sec x15-sec"><h2>Chat apps, more</h2><div class="ctl"><b>Pause a chat app from the chat</b><input class="sw" type="checkbox" id="f15-pause-a-chat-app-from-the-chat" checked="" aria-label="Pause a chat app from the chat" data-sw="set"><small>/pause and /resume in that app.</small></div></div><div class="sec x15-sec"><h2>Chat apps, even more</h2><div class="ctl"><b>Send files into chats</b><input class="sw" type="checkbox" id="f15-send-files-into-chats" checked="" aria-label="Send files into chats" data-sw="set"><small>A Trunk can reply with the file itself, not a link.</small></div><div class="ctl"><b>Relay for chat-app accounts</b><input class="sw" type="checkbox" id="f15-relay-for-chat-app-accounts" aria-label="Relay for chat-app accounts" data-sw="set"><small>Your phone number stays with Branch, not the bot service.</small></div><div class="ctl"><b>Push to your phone and browser</b><input class="sw" type="checkbox" id="f15-push-to-your-phone-and-browser" checked="" aria-label="Push to your phone and browser" data-sw="set"><small>When a Trunk needs you and no chat app is set up.</small></div></div>`;

const TECHNICAL_EXTRA = `<div class="sec"><h2>Technical</h2><dl class="kv"><dt>File</dt><dd>%APPDATA%\\Branch Agent\\gateway.json</dd><dt>mode</dt><dd>off</dd><dt>Address</dt><dd>127.0.0.1:3210 → engine on a private loopback port</dd><dt>startSeconds</dt><dd>90</dd><dt>holdSeconds</dt><dd>20</dd><dt>maxQuickCrashes</dt><dd>4</dd><dt>gapSeconds</dt><dd>300</dd><dt>Health</dt><dd>GET /gateway/health → ok</dd></dl></div><div class="sec x15-sec"><h2>Chat apps, more</h2><div class="ctl"><b>Pause a chat app from the chat</b><input class="sw" type="checkbox" id="f15-pause-a-chat-app-from-the-chat" checked="" aria-label="Pause a chat app from the chat" data-sw="set"><small>/pause and /resume in that app.</small></div></div><div class="sec x15-sec"><h2>From scripts</h2><div class="ctl"><b>Send a message</b><span class="right"><code class="code15">branch send --to telegram "Backup done"</code></span><small>From any script or scheduled job.</small></div><div class="ctl"><b>Connect a chat app</b><span class="right"><code class="code15">branch connect telegram</code></span><small>In one command.</small></div></div><div class="sec x15-sec"><h2>Chat apps, even more</h2><div class="ctl"><b>Send files into chats</b><input class="sw" type="checkbox" id="f15-send-files-into-chats" checked="" aria-label="Send files into chats" data-sw="set"><small>A Trunk can reply with the file itself, not a link.</small></div><div class="ctl"><b>Relay for chat-app accounts</b><input class="sw" type="checkbox" id="f15-relay-for-chat-app-accounts" aria-label="Relay for chat-app accounts" data-sw="set"><small>Your phone number stays with Branch, not the bot service.</small></div><div class="ctl"><b>Push to your phone and browser</b><input class="sw" type="checkbox" id="f15-push-to-your-phone-and-browser" checked="" aria-label="Push to your phone and browser" data-sw="set"><small>When a Trunk needs you and no chat app is set up.</small></div></div>`;

export function draw() {
  const gw = E.state?.gateway ?? {};
  const lev = level();
  const main = BASE + statusSection(gw) + modeSection(gw) + TIMELINE + ACTIONS;

  if (lev === 0) return main;
  if (lev === 1) return main + ADVANCED_EXTRA;
  return main + TECHNICAL_EXTRA;
}

on("gw-mode", (el) => {
  // POST /api/gateway/mode with { mode: el.dataset.v }
});

on("gw-restart", () => {
  // POST /api/gateway/restart
});

markLive(["gw-mode", "gw-restart", "gw-carry", "gw-tray"]);
