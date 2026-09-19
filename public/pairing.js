/* phase2/shell: "Another computer" and "Your phone" in the Add a Trunk studio (critiques #27, #34).

   Both stay inside the studio, under its tab strip, one step at a time with a Back: Pair, Let it in,
   Name it, What it may do. Another computer needs no terminal: on it, Branch's own studio has "Join
   another computer" (POST /api/devices/join), where the invitation is pasted and the number typed.
   The terminal command is still there, folded away, for a computer without the app. Everything a
   device could do starts off, as it always has (src/devices/). Words have data-t keys; no colours. */
import { api, displayView, toast } from "/app.js";
import { qrPicture } from "/devices.js";
import { findDevice, icon, make, platformWord, refresh, say, shell, showOverview } from "/strip.js";
import { button, closeDialog, studio } from "/studio.js";

const $ = (id) => document.getElementById(id);
const STEPS = [["pair", "pair.step.pair", "Pair"], ["letin", "pair.step.letin", "Let it in"], ["name", "pair.step.name", "Name it"], ["may", "pair.step.may", "What it may do"]];
const CAPS = {
  camera: "Take a photo with the camera", screen: "Take a picture of the screen", location: "Say where the device is",
  notify: "Show a notification", "clipboard-read": "Read what was copied", "clipboard-write": "Put text on the clipboard",
  "open-url": "Open a web page", run: "Run a command inside a walled folder", files: "Read and list files in one chosen folder",
  speak: "Say something out loud", listen: "Listen for a few seconds", canvas: "Show a page on the screen",
};
const capKey = (id) => `devices.cap.${id.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`;
export const pair = { kind: "computer", mode: "choose", step: "pair", invite: null, request: null, device: null, seen: new Set(), timers: [], error: null };

function stopTimers() { for (const timer of pair.timers) clearInterval(timer); pair.timers = []; }
function every(ms, work) { pair.timers.push(setInterval(() => { if (!$("studio")) return stopTimers(); void work(); }, ms)); }
document.addEventListener("branch-studio-closed", stopTimers);
/** Sentences with a name or a time in them are drawn again in the new language. */
export function relabelPairing() { if (studio.tab !== "trunk") redraw(); }
function redraw() { stopTimers(); const panel = document.querySelector("#studio .studio-panel"); if (panel) void draw(panel); }
function draw(panel) { return pair.kind === "phone" ? phonePanel(panel, true) : computerPanel(panel, true); }

/** Picked from the strip while it asks: the steps start at Let it in. */
export function askingFrom(request, kind) {
  Object.assign(pair, { kind, mode: "invite", step: "letin", invite: null, request, device: null, error: null });
  pair.seen.add(request.id);
}

/* ---------- the two tabs ---------- */
export async function computerPanel(panel, keep = false) {
  if (!keep || pair.kind !== "computer") Object.assign(pair, { kind: "computer", mode: "choose", step: "pair", invite: null, request: null, device: null, error: null });
  panel.replaceChildren();
  if (pair.mode === "choose") return panel.append(chooser());
  if (pair.mode === "join") return joinPanel(panel);
  return invitePanel(panel);
}
export async function phonePanel(panel, keep = false) {
  if (!keep || pair.kind !== "phone") Object.assign(pair, { kind: "phone", mode: "invite", step: "pair", invite: null, request: null, device: null, error: null });
  panel.replaceChildren();
  return invitePanel(panel);
}
function chooser() {
  const wrap = make("div", "pair-choose");
  const card = (mode, key, english, noteKey, note) => {
    const pick = button("pair-card", null, null, () => { pair.mode = mode; redraw(); });
    pick.append(make("b", "", key, english), make("span", "studio-note", noteKey, note));
    pick.dataset.mode = mode;
    return pick;
  };
  wrap.append(card("invite", "pair.invite", "Invite a computer to this one", "pair.invite.note", "Your other computer lends this Branch what you switch on: its screen, its files in one folder, a notification…"),
    card("join", "pair.join", "Join another computer", "pair.join.note", "Lend this computer to your Branch on another computer, with the invitation and number it shows you."));
  return wrap;
}
function back(to) {
  return button("pair-back", "pair.back", "Back", () => { Object.assign(pair, to); redraw(); });
}
function stepper() {
  const list = make("ol", "pair-steps");
  const at = STEPS.findIndex(([id]) => id === pair.step);
  STEPS.forEach(([id, key, english], index) => {
    const item = make("li", index < at ? "done" : index === at ? "now" : "", key, english);
    if (index === at) item.setAttribute("aria-current", "step");
    list.append(item);
  });
  return list;
}

/* ---------- inviting: the steps on this computer ---------- */
async function invitePanel(panel) {
  const overview = await api("devices").catch((error) => ({ error }));
  if (overview.error) return panel.append(errorLine(overview.error.message));
  if (overview.mode === "off") return panel.append(devicesOff());
  panel.append(stepper());
  if (pair.step === "pair") await pairStep(panel, overview);
  else if (pair.step === "letin") letInStep(panel);
  else if (pair.step === "name") nameStep(panel);
  else mayStep(panel);
}
function devicesOff() {
  const card = make("div", "studio-off");
  card.append(make("p", "studio-lede", "pair.off", "Your devices is switched off."),
    make("p", "studio-note", "pair.off.note", "Switching it on lets you pair your other computers and your phone. Each one can do nothing until you switch its abilities on, one by one."),
    button("studio-primary", "pair.off.on", "Switch it on", async () => { await api("devices/mode", { mode: "when-needed" }); redraw(); }));
  if (pair.kind === "computer") card.prepend(back({ mode: "choose" }));
  return card;
}
async function pairStep(panel, overview) {
  if (!pair.invite || Date.parse(pair.invite.expiresAt) < Date.now()) {
    try { pair.invite = await api("devices/invite", {}); } catch (error) { return panel.append(errorLine(error.message)); }
    for (const request of overview.requests ?? []) pair.seen.add(request.id);
  }
  studio.closing = askToStop;
  if (pair.kind === "computer") panel.prepend(back({ mode: "choose", invite: null }));
  if (onlyHere(pair.invite.link)) panel.append(onlyHereNote());
  panel.append(pair.kind === "phone" ? phoneWays() : computerWays(),
    pair.kind === "phone" ? waiting("pair.waiting.phone", "Waiting for your phone…") : waiting("pair.waiting.computer", "Waiting for the other computer…"));
  every(1000, tickClock);
  every(2000, lookForRequest);
}
/** An invitation to this computer's own address cannot be reached from anywhere else. */
function onlyHere(link) {
  const host = new URL(link).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
function onlyHereNote() {
  const note = make("div", "pair-stop");
  note.append(make("span", "", "pair.onlyHere", "Right now Branch here only answers on this computer itself, so another computer or a phone cannot reach it. Open it to your private network first, then come back for a new invitation."),
    button("", "pair.onlyHere.open", "Open Computer & browser", () => { closeDialog(true); displayView("settings:computer"); }));
  return note;
}
function computerWays() {
  const steps = make("ol", "pair-how");
  const one = make("li"), two = make("li"), three = make("li");
  one.append(make("b", "", "pair.how.open", "On the other computer, open Branch."), " ", make("span", "studio-note", "pair.how.install", "Install it there first if it is not there yet."));
  two.append(make("b", "", "pair.how.press", "Press + at the foot of its strip, choose Another computer, then Join another computer."));
  three.append(make("b", "", "pair.how.paste", "Paste this invitation, and type this number:"), inviteBox());
  steps.append(one, two, three);
  const terminal = make("details", "pair-terminal");
  const summary = make("summary", "", "pair.terminal", "Use a terminal instead");
  const code = make("code", "pair-code");
  code.textContent = `branch node pair "${pair.invite.link}" ${pair.invite.code}`;
  terminal.append(summary, make("p", "studio-note", "pair.terminal.note", "For a computer with Branch's command but no window, run this there:"), code);
  const wrap = make("div");
  wrap.append(steps, terminal);
  return wrap;
}
function inviteBox() {
  const box = make("div", "pair-invite");
  const link = make("code", "pair-link");
  link.id = "pair-link";
  link.textContent = pair.invite.link;
  const copy = button("pair-copy", null, null, async () => {
    await navigator.clipboard.writeText(pair.invite.link).then(() => toast(say("pair.copied", "Copied."))).catch(() => toast(say("pair.copyFailed", "Select the invitation and copy it by hand.")));
  });
  // The words are their own element, so a change of language redraws them and leaves the icon.
  copy.append(icon("copy"), make("span", "", "pair.copy", "Copy"));
  const number = make("p", "pair-number");
  number.id = "pair-number";
  number.textContent = `${pair.invite.code.slice(0, 3)} ${pair.invite.code.slice(3)}`;
  box.append(link, copy, number, clockLine());
  return box;
}
function clockLine() {
  const line = make("p", "studio-note pair-clock");
  line.id = "pair-clock";
  line.textContent = clockWords();
  return line;
}
function clockWords() {
  const left = Math.max(0, Math.round((Date.parse(pair.invite.expiresAt) - Date.now()) / 1000));
  if (!left) return say("pair.expired", "This invitation has run out. Press Back and start again, or switch tabs, for a new one.");
  return say("pair.clock", "Works once, for five minutes: {time} left.", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
}
function tickClock() { const line = $("pair-clock"); if (line && pair.invite) line.textContent = clockWords(); }
function phoneWays() {
  const wrap = make("div", "pair-phone");
  const words = make("div");
  words.append(make("b", "", "pair.phone.scan", "In the Branch app on your phone, press Lend this phone to Branch, then scan this square."),
    make("p", "studio-note", "pair.phone.network", "Your phone reaches this computer over your private network (Tailscale), never the open internet."),
    clockLine(),
    button("", "pair.phone.app", "No Branch app on the phone yet? Get it", () => { closeDialog(true); displayView("customize:channels"); }));
  wrap.append(qrPicture(pair.invite.qr), words);
  return wrap;
}
function waiting(key, english) {
  const line = make("p", "pair-waiting");
  line.append(make("span", "pair-spinner"), make("span", "", key, english));
  line.setAttribute("role", "status");
  return line;
}
function errorLine(text) { const line = make("p", "pair-error"); line.textContent = text; line.setAttribute("role", "alert"); return line; }
async function lookForRequest() {
  const overview = await api("devices").catch(() => null);
  const request = overview?.requests?.find((entry) => !pair.seen.has(entry.id) && entry.status === "waiting");
  if (!request) return;
  pair.seen.add(request.id);
  Object.assign(pair, { step: "letin", request });
  redraw();
}
/** Closing, or leaving the tab, while an invitation is open asks first; Stop pairing then carries on. */
function askToStop(proceed) {
  if (!pair.invite) return true;
  if ($("pair-stop")) return false;
  const bar = make("div", "pair-stop");
  bar.id = "pair-stop";
  bar.setAttribute("role", "alertdialog");
  bar.append(make("b", "", "pair.stop", "Stop pairing?"), make("span", "", "pair.stop.words", "The invitation stops working, and nothing is added."),
    button("", "pair.stop.keep", "Keep pairing", () => bar.remove()),
    button("studio-danger", "pair.stop.go", "Stop pairing", async () => {
      await api("devices/invite/cancel", {}).catch(() => undefined);
      pair.invite = null;
      studio.closing = null;
      stopTimers();
      toast(say("pair.stopped", "Pairing stopped. The invitation no longer works."));
      (proceed ?? (() => closeDialog(true)))();
    }));
  document.querySelector("#studio .studio-panel")?.prepend(bar);
  bar.querySelector("button")?.focus();
  return false;
}

/* ---------- let it in, name it, what it may do ---------- */
function letInStep(panel) {
  studio.closing = askToStop;
  const request = pair.request;
  const card = make("div", "pair-ask");
  card.append(make("p", "studio-lede", "pair.asks", "{name} ({kind}) asks to join.", { name: request.name, kind: platformWord(request.platform) }),
    make("p", "studio-note", "pair.asks.note", "Let it in only if you are pairing it now. Once in, it can do nothing until you switch something on."),
    button("studio-primary", "devices.request.allow", "Let it in", () => decide(true)), button("", "devices.request.refuse", "Refuse", () => decide(false)));
  panel.append(card);
}
async function decide(approve) {
  const { request } = await api(`devices/requests/${pair.request.id}`, { approve });
  pair.invite = null;
  if (!approve) { Object.assign(pair, { step: "pair", request: null }); toast(say("pair.refused", "Refused. Nothing was added.")); return redraw(); }
  await refresh();
  Object.assign(pair, { step: "name", device: findDevice(request.deviceId) ?? { id: request.deviceId, name: request.name, platform: request.platform, offers: request.offers ?? [], enabled: [] } });
  redraw();
}
function nameStep(panel) {
  studio.closing = null;
  const device = pair.device;
  const done = make("div", "pair-done");
  done.append(icon("check"), make("div", "", "pair.paired", "Paired — {name} is on your list.", { name: device.name }));
  const label = make("label", "studio-field");
  const input = document.createElement("input");
  input.id = "pair-name";
  input.value = device.name;
  input.maxLength = 80;
  label.append(make("span", "", "pair.name", "What you call it"), input);
  const next = button("studio-primary", "pair.next", "Next", async () => {
    const name = input.value.trim();
    if (name && name !== device.name) pair.device = (await api(`devices/${device.id}/rename`, { name })).device;
    pair.step = "may";
    redraw();
  });
  panel.append(done, label, make("p", "studio-note", "pair.name.note", "What it is stays underneath: {kind}. You can rename it any time from its face in the strip.", { kind: platformWord(device.platform) }), footer(null, next));
  input.focus();
}
function mayStep(panel) {
  const device = findDevice(pair.device.id) ?? pair.device;
  const list = make("div", "pair-may");
  const offered = (device.canOffer ?? Object.keys(CAPS)).filter((cap) => !device.offers || device.offers.includes(cap));
  for (const cap of offered) {
    const row = make("label", "studio-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = (device.enabled ?? []).includes(cap);
    box.dataset.cap = cap;
    box.addEventListener("change", () => void api(`devices/${device.id}/switch`, { capability: cap, on: box.checked }).catch((error) => { box.checked = !box.checked; toast(error.message); }));
    row.append(box, make("span", "", capKey(cap), CAPS[cap] ?? cap));
    list.append(row);
  }
  if (!offered.length) list.append(make("p", "studio-note", "pair.may.none", "It offers nothing Branch can switch on yet."));
  const finish = button("studio-primary", "pair.finish", "Finish", async () => {
    closeDialog(true);
    await refresh();
    showOverview(`device:${device.id}`);
    toast(say("pair.ready", "{name} is ready. It stays connected while Branch runs on it, and nothing on it is used until you switch it on.", { name: device.name }));
  });
  panel.append(make("p", "", "pair.may.words", "What Branch may do on it. Everything starts off; switch on only what you want Branch to use."), list, footer({ step: "name" }, finish));
}
function footer(backTo, next) {
  const foot = make("div", "studio-foot");
  if (backTo) foot.append(back(backTo));
  foot.append(make("span", "grow"), next);
  return foot;
}

/* ---------- joining: this computer lent to another Branch ---------- */
async function joinPanel(panel) {
  const status = await api("devices/join").catch((error) => ({ state: "failed", message: error.message }));
  panel.append(back({ mode: "choose" }));
  if (status.state === "waiting" || status.state === "joined") return panel.append(joinStatus(status));
  if (status.message) panel.append(errorLine(status.message));
  panel.append(joinForm());
}
function joinForm() {
  const form = make("form", "pair-join");
  const input = (id, key, english, hintKey, hint) => {
    const label = make("label", "studio-field");
    const box = document.createElement("input");
    box.id = id;
    box.autocomplete = "off";
    box.placeholder = say(hintKey, hint);
    box.dataset.tPlaceholder = hintKey;
    label.append(make("span", "", key, english), box);
    return label;
  };
  form.append(make("p", "", "pair.join.words", "On the computer you are joining, open Add a Trunk › Another computer › Invite a computer to this one. It shows an invitation and a number."),
    input("join-link", "pair.join.link", "The invitation", "pair.join.link.hint", "Paste it here"),
    input("join-code", "pair.join.code", "The number", "pair.join.code.hint", "Six digits"),
    input("join-name", "pair.join.name", "What to call this computer there", "pair.join.name.hint", "For example: Kitchen laptop"));
  const go = make("button", "studio-primary", "pair.join.go", "Join");
  go.type = "submit";
  form.append(go);
  form.addEventListener("submit", (event) => { event.preventDefault(); void join(form); });
  return form;
}
async function join(form) {
  const name = $("join-name").value.trim();
  try {
    await api("devices/join", { link: $("join-link").value.trim(), code: $("join-code").value.trim(), ...(name ? { name } : {}) });
    redraw();
  } catch (error) {
    form.querySelector(".pair-error")?.remove();
    form.prepend(errorLine(error.message));
  }
}
function joinStatus(status) {
  const wrap = make("div", "pair-joined");
  const where = status.hub ?? "";
  if (status.state === "waiting") wrap.append(waiting("pair.join.waiting", "Waiting for the owner to let this computer in, on the other computer."));
  else if (status.connected) wrap.append(make("p", "studio-lede", "pair.join.done", "Joined. Branch at {where} can now use what its owner switches on for this computer — everything starts off. It stays connected while Branch runs here.", { where }));
  else wrap.append(make("p", "studio-lede", "pair.join.connecting", "Joined Branch at {where}. Connecting…", { where }), ...(status.message ? [errorLine(status.message)] : []));
  wrap.append(button("studio-danger", "pair.join.leave", status.state === "waiting" ? "Stop" : "Leave", async () => { await api("devices/join/leave", {}); redraw(); }));
  every(2000, async () => {
    const now = await api("devices/join").catch(() => null);
    if (now && (now.state !== status.state || now.connected !== status.connected)) redraw();
  });
  return wrap;
}
