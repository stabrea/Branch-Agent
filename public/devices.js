/* mac7/nodes: "Your devices" — the owner's other computers and phone lending Branch a few abilities.

   customize:channels   the Devices card: the switch, pairing, waiting requests, each device with its
                        per-capability switches (all off), its folder, who it is shared with, last seen
                        and Remove.
   the message box      a small "Use device" picker, shown only while a device is paired; it decides
                        which device the next message's device tools use.

   Every word has a data-t key with English and French (public/locales/). No colour is written here. */
import { api } from "/app.js";
import { formatDate, t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
function make(tag, className, key, english, values) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // A sentence with a name or a number in it is redrawn on a language change rather than re-read by key.
  if (key && values) { node.dataset.tTemplate = key; node.textContent = say(key, english, values); }
  else if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(key, english, handler, quiet = true) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };

const MODES = [["off", "devices.mode.off", "Off"], ["when-needed", "devices.mode.whenNeeded", "When needed"], ["on", "devices.mode.on", "On"]];
const CAPS = {
  camera: "Take a photo with the camera", screen: "Take a picture of the screen", location: "Say where the device is",
  notify: "Show a notification", "clipboard-read": "Read what was copied", "clipboard-write": "Put text on the clipboard",
  "open-url": "Open a web page", run: "Run a command inside a walled folder", files: "Read and list files in one chosen folder",
  speak: "Say something out loud", listen: "Listen for a few seconds", canvas: "Show a page on the screen",
};
const PLATFORMS = { darwin: "Mac computer", linux: "Linux computer", win32: "Windows computer", ios: "iPhone or iPad", android: "Android phone" };
const capKey = (id) => `devices.cap.${id.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`;
const platformKey = (id) => `devices.platform.${id}`;
const computer = (platform) => ["darwin", "linux", "win32"].includes(platform);

let drawing = null;
let picked = null;
let pickedFor = null;
let invite = null;

function qrPicture(qr) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const quiet = 4, size = qr.size + quiet * 2;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "devices-qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", say("devices.qr", "Square barcode for the phone app"));
  svg.style.background = "var(--paper)";
  svg.style.color = "var(--paper-text)";
  svg.style.width = "min(220px, 100%)";
  svg.style.height = "auto";
  qr.rows.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      if (line[x] !== "1") continue;
      const square = document.createElementNS(ns, "rect");
      for (const [name, value] of [["x", x + quiet], ["y", y + quiet], ["width", 1], ["height", 1], ["fill", "currentColor"]]) square.setAttribute(name, String(value));
      svg.append(square);
    }
  });
  return svg;
}

function inviteBox(invite) {
  const box = document.createElement("div");
  box.id = "devices-invite";
  const command = `branch node pair "${invite.link}" ${invite.code}`;
  const code = plain("code", command);
  code.style.overflowWrap = "anywhere";
  box.append(make("p", "", "devices.invite.number", `Number: ${invite.code}`, { code: invite.code }),
    make("p", "subtle", "devices.invite.computer", "On the other computer, run this in a terminal:"), code,
    make("p", "subtle", "devices.invite.phone", "On the phone, open the Branch app and scan this square:"), qrPicture(invite.qr),
    make("p", "field-note", "devices.invite.expires", "The invitation works once and for five minutes."));
  return box;
}

function modeSwitch(view, status) {
  const select = segmented({
    id: "devices-mode",
    options: MODES,
    value: view.mode,
    onChange: async (mode) => {
      try { await api("devices/mode", { mode }); await draw(); } catch (error) { tell(status, error); }
    }
  });
  const label = make("label", "", "devices.mode.label", "Using your other devices");
  label.htmlFor = select.id;
  return [label, select];
}

/* mac7/residuals: "Let it in" waits until the owner ticks that the codes match; the tick outlives a redraw. */
const codesMatched = new Set();
function matchBox(request, allow) {
  const label = make("label", "pair-match");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = codesMatched.has(request.id);
  allow.disabled = !box.checked;
  box.addEventListener("change", () => {
    if (box.checked) codesMatched.add(request.id); else codesMatched.delete(request.id);
    allow.disabled = !box.checked;
  });
  label.append(box, make("span", "", "pair.check.matches", "The code matches"));
  return label;
}

function requestRow(request, status) {
  const line = make("p", "", "devices.request.line", `${request.name} (${PLATFORMS[request.platform]}) asks to join.`,
    { name: request.name, platform: say(platformKey(request.platform), PLATFORMS[request.platform]) });
  const said = (approve) => (approve ? { approve, codeMatches: codesMatched.has(request.id) } : { approve }); // mac7/residuals (integration)
  const answer = (approve) => async () => { try { await api(`devices/requests/${request.id}`, said(approve)); await draw(); } catch (error) { tell(status, error); } };
  const box = document.createElement("div");
  box.className = "devices-request";
  const allow = button("devices.request.allow", "Let it in", answer(true), false);
  box.append(line, row(allow, button("devices.request.refuse", "Refuse", answer(false))));
  // phase2/shell integration review: the check code the device shows while it waits.
  if (request.check) box.insertBefore(make("p", "subtle", "pair.check", `Check code ${request.check}. The other computer shows the same code while it waits. If they differ, press Refuse.`, { check: request.check }), line.nextSibling);
  if (request.check) box.insertBefore(matchBox(request, allow), box.lastChild);
  return box;
}

function switches(device, status) {
  const set = document.createElement("fieldset");
  set.append(make("legend", "", "devices.device.switches", "What Branch may do on it (each asks first when it captures or runs)"));
  // What the device said it can do (it looked for the programs it needs); everything its kind could, before it has said.
  for (const id of device.offers.length ? device.offers : device.canOffer) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `device-${device.id}-${id}`;
    box.checked = device.enabled.includes(id);
    box.addEventListener("change", async () => {
      try { await api(`devices/${device.id}/switch`, { capability: id, on: box.checked }); } catch (error) { box.checked = !box.checked; tell(status, error); }
    });
    const label = document.createElement("label");
    label.className = "check";
    label.htmlFor = box.id;
    label.append(box, make("span", "", capKey(id), CAPS[id]));
    set.append(label);
  }
  return set;
}

function folderRow(device, status) {
  const input = document.createElement("input");
  input.id = `device-${device.id}-folder`;
  input.value = device.folder ?? "";
  input.placeholder = say("devices.device.folderHint", "A full path on that computer");
  const label = make("label", "", "devices.device.folder", "The one folder it may read and run commands in");
  label.htmlFor = input.id;
  const save = button("devices.save", "Save", async () => {
    try { await api(`devices/${device.id}/folder`, { folder: input.value.trim() || null }); status.dataset.t = "devices.saved"; status.textContent = say("devices.saved", "Saved."); }
    catch (error) { tell(status, error); }
  });
  return [label, input, row(save)];
}

function shareRow(device, people, status) {
  if (!people.length) return [];
  const set = document.createElement("fieldset");
  set.append(make("legend", "", "devices.device.share", "Who else on this computer may use it"));
  for (const person of people) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `device-${device.id}-share-${person.id}`;
    box.checked = device.sharedWith.includes(person.id);
    box.addEventListener("change", async () => {
      const others = [...set.querySelectorAll("input:checked")].map((each) => each.id.slice(`device-${device.id}-share-`.length));
      try { await api(`devices/${device.id}/share`, { profiles: others }); } catch (error) { box.checked = !box.checked; tell(status, error); }
    });
    const label = document.createElement("label");
    label.className = "check";
    label.htmlFor = box.id;
    label.append(box, plain("span", person.name));
    set.append(label);
  }
  return [set];
}

function deviceBlock(device, people, status) {
  const block = document.createElement("div");
  block.className = "devices-device";
  block.id = `device-${device.id}`;
  const seen = device.connected ? make("span", "", "devices.device.connected", "Connected now")
    : device.lastSeen ? make("span", "", "devices.device.lastSeen", `Last seen ${formatDate(device.lastSeen)}`, { when: formatDate(device.lastSeen) })
    : make("span", "", "devices.device.never", "Not connected yet");
  const about = document.createElement("p");
  about.className = "subtle";
  about.append(make("span", "", platformKey(device.platform), PLATFORMS[device.platform]), plain("span", " · "), seen);
  block.append(plain("h3", device.name), about, switches(device, status));
  if (computer(device.platform)) block.append(...folderRow(device, status));
  block.append(...shareRow(device, people, status));
  block.append(row(button("devices.device.remove", "Remove this device", async () => {
    try { await api(`devices/${device.id}/revoke`, {}); await draw(); } catch (error) { tell(status, error); }
  })));
  return block;
}

async function buildCard() {
  const view = await api("devices");
  const node = make("section", "card");
  node.id = "devices-card";
  node.dataset.home = "customize:channels";
  node.append(make("h2", "", "devices.title", "Your devices"),
    make("p", "subtle", "devices.purpose", "Let your other computers and your phone lend Branch a camera, a screen, notifications and more. Everything starts off, and you switch each thing on per device."));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  node.append(...modeSwitch(view, status));
  if (view.mode !== "off") {
    const people = await api("profiles").then((answer) => answer.profiles ?? []).catch(() => []);
    const inviteSlot = document.createElement("div");
    node.append(row(button("devices.pair", "Pair a device", async () => {
      try { invite = await api("devices/invite", {}); inviteSlot.replaceChildren(inviteBox(invite)); } catch (error) { tell(status, error); }
    }, false)), inviteSlot);
    // The invitation stays on screen while it is still the one on offer, through the regular redraws.
    if (invite && view.invitation?.id === invite.id) inviteSlot.append(inviteBox(invite));
    if (view.requests.length) node.append(make("h3", "", "devices.waiting", "Waiting for your yes"), ...view.requests.map((request) => requestRow(request, status)));
    node.append(view.devices.length ? make("h3", "", "devices.list", "Paired devices") : make("p", "field-note", "devices.none", "No device is paired yet."));
    node.append(...view.devices.map((device) => deviceBlock(device, people, status)));
  }
  node.append(status);
  return { node, view };
}

function picker(view) {
  const form = $("chat-form");
  const send = $("new-session");
  if (!form || !send) return;
  let wrap = $("composer-device-wrap");
  const show = view.mode !== "off" && view.devices.length > 0;
  if (!show) { if (wrap) wrap.hidden = true; return; }
  if (!wrap) {
    wrap = document.createElement("label");
    wrap.id = "composer-device-wrap";
    wrap.className = "check composer-specialist";
    const select = dropdown({
      id: "composer-device",
      options: [["", "devices.picker.any"]],
      value: ""
    });
    select.setAttribute("aria-label", say("devices.picker.label", "Which device to use"));
    select.addEventListener("change", () => void choose(select.value || null));
    wrap.append(make("span", "sr-only", "devices.picker.label", "Which device to use"), select);
    send.before(wrap);
  }
  wrap.hidden = false;
  const select = $("composer-device");
  const deviceOptions = [["", "devices.picker.any"], ...view.devices.map((device) => [device.id, "", device.name])];
  select.setOptions?.(deviceOptions);
  select.value = picked ?? "";
}

async function choose(deviceId) {
  picked = deviceId;
  const sessionId = globalThis.branchSessionId?.();
  if (!sessionId) return;
  pickedFor = sessionId;
  await api("devices/pick", { sessionId, deviceId }).catch(() => undefined);
}

async function draw() {
  if (drawing) return drawing;
  drawing = (async () => {
    try {
      const { node, view } = await buildCard();
      const old = $("devices-card");
      if (old) old.replaceWith(node); else document.body.append(node);
      picker(view);
    } catch { /* the window stays as it was; the next draw tries again */ }
  })().finally(() => { drawing = null; });
  return drawing;
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}

whenReady(() => {
  void draw();
  document.addEventListener("branch-language", () => void draw());
  // New requests and connections show up without a reload, and a picked device follows a new conversation.
  setInterval(() => {
    if (!document.hidden && !$("devices-card")?.contains(document.activeElement)) void draw();
    if (picked && globalThis.branchSessionId?.() && globalThis.branchSessionId() !== pickedFor) void choose(picked);
  }, 5000);
});

// mac7/phone-qr: the "Get Branch on your phone" card draws its code the same way.
export { qrPicture };
