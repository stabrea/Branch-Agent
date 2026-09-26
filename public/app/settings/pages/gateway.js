/* Settings › Gateway, 1:1 with the prototype at each level, from GET /api/never-break. "Carry on interrupted work by
   itself" is what the engine does while the gateway is On, so it shows that and has no switch of its own (greyed); the
   tray icon and push have no route (greyed). Pausing a chat app from the chat (POST /api/reach/switch) and sending files
   into chats (POST /api/personal/switch) are live three-way switches: on unless "off", turned on as "when-needed". The
   relay holds the owner's chat-app accounts, so it stays greyed. */
import { level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render, esc } from "../../core/dom.js";
import { toast, ic } from "../../core/ui.js";
import { id15, sw15, code15, sec15 } from "../rows15.js";
import { gateway17, initMore17 } from "../p17-more.js";

let gwData = null;
const D = { reach: null, personal: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
const mode = (on) => (on ? "when-needed" : "off");

const WIRES = {
  "f15-pause-a-chat-app-from-the-chat": [() => onMode(D.reach?.modes?.["platform-pause"]), (on) => api("reach/switch", { part: "platform-pause", mode: mode(on) })],
  "f15-send-files-into-chats": [() => onMode(D.personal?.modes?.["chat-files"]), (on) => api("personal/switch", { part: "chat-files", mode: mode(on) })],
};
const sw = (title, sub) => sw15(title, sub, WIRES[id15(title)]?.[0]() ?? false);

async function loadGateway() {
  const [gw, reach, personal] = await Promise.all(["never-break", "reach", "personal"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  gwData = gw; Object.assign(D, { reach, personal });
  render();
}

/* A change the assistant suggested (the gateway.propose tool): timings only; the engine keeps the owner's switch and
   the engine's own settings as they are, and refuses a change that did not start cleanly on its throwaway try. */
async function answerProposal(use) {
  try {
    const done = await api(use ? "never-break/proposal/accept" : "never-break/proposal/discard", {});
    toast(use ? done.note : "Discarded. Nothing changed.");
  } catch (e) {
    toast(e.message);
  }
  await loadGateway();
}

export function init() {
  initMore17();
  const reading = loadGateway();
  on("gw-mode", (el) => {
    const next = el.dataset.v;
    api("never-break", { mode: next }).then(() => loadGateway(), (e) => toast(e.message));
  });
  on("gw-prop", (el) => answerProposal(el.dataset.v === "use"));
  markLive(["gw-mode", "gw-prop", "sw:f15-pause-a-chat-app-from-the-chat", "sw:f15-send-files-into-chats"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadGateway();
  });
  return reading;
}

/* The Gateway three-way is drawn pressed from the engine's saved mode, so Settings waits for this page's read. */
export const waitFirst = true;

export async function load() {
  await loadGateway();
}

const BASE = `<h1>Gateway</h1><p class="lede">A small helper that keeps Branch running in the background, starts it again if it stops, and carries interrupted work on.</p>`;

function statusSection(gw) {
  if (!gw) return "";
  const mode = gw.mode;
  const isOn = mode === "on";
  const isWhenNeeded = mode === "when-needed";
  const sdotClass = isOn || isWhenNeeded ? "ok" : "bad";
  const title = isOn ? "The gateway is on" : isWhenNeeded ? "The gateway is when-needed" : "The gateway is off";
  const desc = isOn ? "On. Telegram, your phone and automations keep working when the window is closed, and it restarts the engine if it stops." : isWhenNeeded ? "When needed. It starts when a Trunk or a message needs it, and stops after the last task." : "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.";

  return `<div class="status"><span class="sdot ${sdotClass}"></span><div><b>${title}</b><p>${desc}</p></div></div>`;
}

function modeSection(gw) {
  const mode = gw?.mode ?? null;
  const seg = [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]].map(([v, l]) => `<button type="button" aria-pressed="${mode === v}" data-act="gw-mode" data-v="${v}">${l}</button>`).join("");
  return `<div class="sec"><h2>Keep Branch running</h2><div class="ctl"><b>Gateway</b><span class="right"><span class="seg" role="group" aria-label="Gateway">${seg}</span></span><small>Recommended: On. Telegram, your phone and automations keep working when the window is closed.</small></div>`
    + `<div class="ctl"><b>Carry on interrupted work by itself</b><input class="sw" type="checkbox" id="gw-carry" ${mode === "on" ? "checked" : ""} aria-label="Carry on interrupted work by itself" data-sw="set"><small>After a restart, safe steps carry on. Anything that sends or changes something asks you first.</small></div>`
    + `<div class="ctl"><b>Show the gateway in the tray</b><input class="sw" type="checkbox" id="gw-tray" aria-label="Show the gateway in the tray" data-sw="set"><small>A small Branch icon by the clock with Restart and Quit.</small></div></div>`;
}

/* What it has been doing: while the gateway is off the prototype's one line is simply true; the engine keeps no list
   of the gateway's own events here, so none is written in while it is on. */
function doing(gw) {
  const rows = gw?.mode === "off" ? `<li class="">${ic("info", "s")}<span>Nothing is watching Branch<small>The gateway is off, so a stopped engine stays stopped</small></span><time></time></li>` : "";
  return `<div class="sec"><h2>What it has been doing</h2><ol class="tl">${rows}</ol></div>`;
}

/* 1:1 with the prototype's tile, shown while the gateway is not off: the reason is the assistant's own words, and the
   pill only when the engine's throwaway try passed. */
function proposalTile(gw) {
  const p = gw?.proposal;
  if (!p || (gw.mode ?? "off") === "off") return "";
  const passed = p.check?.ok ? '<span class="pill ok ml">Tried on a test gateway · passed</span>' : "";
  return `<div class="tile" data-css="margin-top:22px"><div class="th"><b>A change Branch suggested</b>${passed}</div><p>${esc(p.why)}</p><div class="acts"><button class="btn pri sm" type="button" data-act="gw-prop" data-v="use">Use it</button><button class="btn ghost sm" type="button" data-act="gw-prop" data-v="no">Discard</button></div></div>`;
}

const ACTIONS = `<div class="acts" data-css="margin-top:16px"><button class="btn" type="button" data-act="gw-restart">${ic("retry", "s")}Restart the engine</button></div>`;

/* The gateway's own settings, as the engine holds them. */
function technical(gw) {
  const c = gw?.config ?? {};
  const rows = [["mode", gw?.mode], ["startSeconds", c.startSeconds], ["holdSeconds", c.holdSeconds], ["maxQuickCrashes", c.maxQuickCrashes], ["gapSeconds", c.gapSeconds]]
    .filter(([, v]) => v != null).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="sec"><h2>Technical</h2><dl class="kv">${rows}</dl></div>`;
}

const chatMore = () => sec15("Chat apps, more", sw("Pause a chat app from the chat", "/pause and /resume in that app."));
const fromScripts = () => sec15("From scripts",
  code15("Send a message", "From any script or scheduled job.", "branch send --to telegram \"Backup done\"")
  + code15("Connect a chat app", "In one command.", "branch connect telegram"));
const chatEvenMore = () => sec15("Chat apps, even more",
  sw("Send files into chats", "A Trunk can reply with the file itself, not a link.")
  + sw("Relay for chat-app accounts", "Your phone number stays with Branch, not the bot service.")
  + sw("Push to your phone and browser", "When a Trunk needs you and no chat app is set up."));

export function draw() {
  const gw = gwData;
  const lev = level();
  let html = BASE + statusSection(gw) + modeSection(gw) + doing(gw) + proposalTile(gw) + ACTIONS;
  if (lev < 2) html += `<p class="hint">Switch to Technical (bottom left) to see file paths, ports and raw settings.</p>`;
  else html += technical(gw);
  if (lev >= 1) html += chatMore();
  if (lev >= 2) html += fromScripts();
  if (lev >= 1) html += chatEvenMore();
  return html + gateway17(lev);
}
