/* Settings › Developer, 1:1 with the prototype (only shown at the Technical level). The local address is the one this
   window is talking to; Copy puts it on the clipboard. A switch shows the engine's own value and is live only where a
   route changes it (WIRES); a three-way feature switch reads as on unless its mode is "off", turns on as "when-needed"
   and off as "off". The session key is never shown; making a new one, the tool playground (it runs a tool from the
   window), sandboxed tool scripts, tools that join from outside and finding other computers stay greyed. */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { id15, sw15, btn15, code15, seg15, sec15 } from "../rows15.js";

const D = { ls: null, dbg: null, interop: null, counters: null, loop: null, comfort: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
const mode = (on) => (on ? "when-needed" : "off");
const part = (name) => D.interop?.parts?.find((p) => p.part === name)?.mode;

/* Language servers and debug adapters: the route replaces the whole record, so the one read is sent back with only
   "enabled" changed. */
const WIRES = {
  "dv-ls": [() => D.ls?.enabled === true, (on) => api("developer/language-servers", { ...D.ls, enabled: on })],
  "dv-dbg": [() => D.dbg?.enabled === true, (on) => api("developer/debug-adapters", { ...D.dbg, enabled: on })],
  [id15("Flow search")]: [() => onMode(part("flow-search")), (on) => api("interop/switch", { part: "flow-search", mode: mode(on) })],
  [id15("Send metrics with OpenTelemetry")]: [() => onMode(D.counters?.mode), (on) => api("usage/counters", { mode: mode(on) })],
  [id15("Is Branch keeping up")]: [() => onMode(D.loop?.mode), (on) => api("event-loop", { mode: mode(on) })],
};
const value = (id) => WIRES[id]?.[0]() ?? false;
const sw = (title, sub) => sw15(title, sub, value(id15(title)));

export function draw() {
  const statusLine = D.comfort ? (D.comfort.values?.display?.statusLine == null ? "default" : null) : null;
  let html = "<h1>Developer</h1><p class=\"lede\">For people building on Branch.</p>";
  html += "<div class=\"sec\"><h2>Local address</h2>";
  html += `<div class="ctl"><b>${esc(location.host)}</b><span class="right"><button class="btn sm" type="button" data-act="dv-copy">Copy</button></span><small>Only this computer can reach it. Requests need your session key.</small></div>`;
  html += "<div class=\"ctl\"><b>Session key</b><span class=\"right\"><span data-css=\"font:12px var(--mono);color:var(--ink-3)\">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Make a new one</button></span><small>Never shown in full here.</small></div>";
  html += "</div>";
  html += "<div class=\"sec\"><h2>Help with code</h2>";
  html += `<div class="ctl"><b>Use language servers</b><input class="sw" type="checkbox" id="dv-ls" ${value("dv-ls") ? "checked" : ""} aria-label="Use language servers" data-sw="set"><small>Programs you already installed, one per line.</small></div>`;
  html += `<div class="ctl"><b>Use a debugger</b><input class="sw" type="checkbox" id="dv-dbg" ${value("dv-dbg") ? "checked" : ""} aria-label="Use a debugger" data-sw="set"><small>Nothing downloads, and nothing runs until this is on.</small></div>`;
  html += "</div>";
  html += sec15("Tools, technical",
    btn15("Turn an OpenAPI file into tools", "", "Choose a file")
    + sw("Tool scripts and WebAssembly", "Sandboxed JavaScript and .wasm add-ons.")
    + sw("Tools that join over a WebSocket", `ws://${location.host}/api/interop/client-tools/ws`)
    + seg15("Hardware adapters", "", [["off", "Off"], ["serial", "Serial"], ["gpio", "GPIO"], ["i2c", "I2C"], ["spi", "SPI"]], null)
    + sw("Load tools only when needed", "Thousands of tools at the cost of dozens.")
    + btn15("Playground", "Try any tool through a form.", "Open", "playground-open"));
  html += sec15("Automations, technical",
    sw("Flow search", "Tries four versions of a flow on examples and keeps the best.")
    + code15("Loop a prompt", "Or /heartbeat for the check-in list.", "/loop 10m check the build"));
  html += sec15("System",
    sw("Portable mode", "Data beside the program, for a USB stick.")
    + sw("Send metrics with OpenTelemetry", "otlp://127.0.0.1:4317")
    + seg15("Status line", "", [["default", "Default"], ["minimal", "Minimal"], ["script", "My script"]], statusLine)
    + sw("Find Branch on other computers nearby", "Tools and models on your network.")
    + sw("Is Branch keeping up", "Warns when the engine stalls for more than 5 seconds.")
    + sw("Save task trajectories", "Every step as JSON Lines, for analysis."));
  return html;
}

async function loadAll() {
  const [ls, dbg, interop, counters, loop, comfort] = await Promise.all(
    ["developer/language-servers", "developer/debug-adapters", "interop", "usage/counters", "event-loop", "comfort"]
      .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { ls, dbg, interop, counters: counters?.counters ?? null, loop: loop?.settings ?? null, comfort });
  render();
}

async function copyAddress() {
  try { await navigator.clipboard.writeText(location.host); toast("Copied."); } catch (error) { toast(error.message); }
}

export function init() {
  on("dv-copy", () => copyAddress());
  markLive(["dv-copy", ...Object.keys(WIRES).map((id) => "sw:" + id)]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "dv-copy": true };
