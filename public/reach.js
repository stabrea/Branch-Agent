/* r17-i: reach and platform. Each card is placed by public/layout.js through data-home, and every
   part has the owner's three-way switch, starting off. Every control has a label and a sentence
   saying what it does (aria-describedby).

   settings:computer         Other computers side by side; using apps in the background; USB devices
   settings:skills           Trunks on other computers
   settings:models:media     Making videos
   settings:channels         The chat relay; sending and pausing chat apps
   settings:skills           Sharing the assistant through git; skill bundles
   library:documents         Notes
   settings:models:second    Model arena */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { dropdown, switchControl } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** A label, the control, and one sentence saying what it does, tied together for screen readers. */
function control(id, key, english, hintKey, hint, element) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  element.id = id;
  const note = make("p", "subtle", hintKey, hint);
  note.id = `${id}-hint`;
  element.setAttribute("aria-describedby", note.id);
  return [label, element, note];
}
function field(value = "", type = "text") {
  const node = document.createElement(type === "area" ? "textarea" : "input");
  if (type !== "area") node.type = type;
  node.value = value;
  return node;
}
function choice(options, value) {
  return dropdown({ id: "", options, value });
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node, key = "reach.saved", english = "Saved.") => { node.dataset.t = key; node.textContent = say(key, english); };
function button(id, key, english, hintKey, hint, handler) {
  const node = make("button", "quiet-button", key, english);
  node.type = "button";
  node.id = id;
  const note = make("span", "sr-only", hintKey, hint);
  note.id = `${id}-hint`;
  node.setAttribute("aria-describedby", note.id);
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return [node, note];
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children.flat());
  return node;
}
const act = (status, work) => async () => { try { await work(); await drawCards(); } catch (error) { tell(status, error); } };
const attempt = (status, work) => async () => { try { await work(); } catch (error) { tell(status, error); } };

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "When needed"]];

function switchFor(part, modes, status) {
  const select = choice(POSITIONS, modes[part]);
  select.addEventListener("change", act(status, () => api("reach/switch", { part, mode: select.value })));
  return control(`reach-switch-${part}`, `reach.part.${part}`, part, "reach.switch.hint", "Off: nothing of this runs. On: it is ready from the start. When needed: it is offered when the work calls for it.", select);
}

function card(id, home, titleKey, title, purposeKey, purpose) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = home;
  node.append(make("h2", "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  return { node, status };
}
const list = (items) => { const ul = document.createElement("ul"); ul.append(...items); return ul; };
/** Columns side by side that fold into one at a narrow width, so nothing scrolls sideways. */
function columns() {
  const node = document.createElement("div");
  Object.assign(node.style, { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))", gap: "0.75rem" });
  return node;
}

/* ---------- settings:computer — other computers side by side ---------- */
function machineColumn(answer) {
  const box = document.createElement("div");
  box.className = "card";
  const data = answer.data ?? {};
  const working = Array.isArray(data) ? data : [];
  box.append(plain("h3", answer.name),
    answer.ok ? make("p", "subtle", "reach.machines.up", "Answering.") : plain("p", answer.note, "subtle"));
  if (answer.ok) box.append(make("p", "subtle", "reach.machines.working", "Working now:"),
    list(working.slice(0, 10).map((a) => plain("li", String(a.prompt ?? a.title ?? a.runId ?? "").slice(0, 120)))));
  return box;
}

async function machinesCard(state) {
  const { node, status } = card("reach-machines-card", "settings:computer", "reach.machines.title", "Other computers side by side",
    "reach.machines.purpose", "See and start work on your other computers running Branch from this window. They are the computers added under \"Other computers running Branch\".");
  const name = field(state.machineName);
  const [save, saveHint] = button("reach-machine-name-save", "reach.machines.saveName", "Save the name", "reach.machines.saveNameHint", "Keeps this computer's name.",
    attempt(status, async () => { await api("reach/machine-name", { name: name.value.trim() }); done(status); }));
  node.append(...switchFor("machines", state.modes, status),
    ...control("reach-machine-name", "reach.machines.name", "This computer's name", "reach.machines.nameHint", "Lower-case letters, numbers and dashes. The others write a Trunk here as @name-thisname.", name),
    row(save, saveHint));
  if (state.modes.machines !== "off") {
    const side = columns();
    const target = field("");
    const prompt = field("", "area");
    const [look, lookHint] = button("reach-machines-look", "reach.machines.look", "Show what each is doing", "reach.machines.lookHint", "Asks every computer at once and shows one column each.",
      attempt(status, async () => { side.replaceChildren(...(await api("reach/machines/all", { view: "working" })).map(machineColumn)); }));
    const [start, startHint] = button("reach-machines-start", "reach.machines.start", "Start it there", "reach.machines.startHint", "Starts the task on that computer; its own approval rules decide what it may do.",
      attempt(status, async () => { await api("reach/machines/start", { machine: target.value.trim(), prompt: prompt.value }); done(status, "reach.machines.started", "Started."); }));
    node.append(row(look, lookHint), side,
      ...control("reach-machines-target", "reach.machines.target", "Computer", "reach.machines.targetHint", "The short name the computer was added with.", target),
      ...control("reach-machines-prompt", "reach.machines.prompt", "Task", "reach.machines.promptHint", "What that computer should do.", prompt),
      row(start, startHint));
  }
  node.append(status);
  return node;
}

/* ---------- settings:skills — Trunks on other computers ---------- */
async function trunksCard(state) {
  const { node, status } = card("reach-trunks-card", "settings:skills", "reach.trunks.title", "Trunks on other computers",
    "reach.trunks.purpose", "Your other computers share the names and titles of their Trunks, and a Trunk here can send one a message. Nothing else is shared.");
  node.append(...switchFor("remote-trunks", state.modes, status));
  if (state.modes["remote-trunks"] !== "off") {
    const shown = document.createElement("div");
    const to = field(""), from = field(""), text = field("", "area");
    const [look, lookHint] = button("reach-trunks-look", "reach.trunks.look", "Show them", "reach.trunks.lookHint", "Asks each computer for its Trunks.",
      attempt(status, async () => {
        const { computers } = await api("reach/trunks/remote", {});
        shown.replaceChildren(list(computers.flatMap((c) => c.trunks.map((tr) => plain("li", `${tr.address} — ${tr.title}`)))));
      }));
    const [send, sendHint] = button("reach-trunks-send", "reach.trunks.send", "Send the message", "reach.trunks.sendHint", "Delivered once, with one retry if the other computer is busy.",
      attempt(status, async () => {
        const receipt = await api("reach/trunks/message", { to: to.value.trim(), from: from.value.trim(), text: text.value });
        if (receipt.delivered) done(status, "reach.trunks.delivered", "Delivered."); else tell(status, new Error(receipt.reason));
      }));
    node.append(row(look, lookHint), shown,
      ...control("reach-trunks-to", "reach.trunks.to", "To", "reach.trunks.toHint", "Written @name-computer.", to),
      ...control("reach-trunks-from", "reach.trunks.from", "From (a Trunk here)", "reach.trunks.fromHint", "The short name of the Trunk sending it.", from),
      ...control("reach-trunks-text", "reach.trunks.text", "Message", "reach.trunks.textHint", "At most 4000 characters.", text),
      row(send, sendHint));
  }
  node.append(status);
  return node;
}

/* ---------- settings:computer — using apps in the background ---------- */
async function backgroundCard(state) {
  const { node, status } = card("reach-background-card", "settings:computer", "reach.background.title", "Using apps in the background",
    "reach.background.purpose", "On a Mac or Linux, Branch can press a named button or fill a field in another app without moving your pointer or taking the focus.");
  node.append(...switchFor("background-screen", state.modes, status),
    make("p", "subtle", "reach.background.permission", "On a Mac, the first use asks you to allow Branch under Privacy & Security, Accessibility. On Linux it needs the accessibility bus and xdotool."),
    status);
  return node;
}

/* ---------- settings:computer — USB devices ---------- */
function usbRule(rule, status) {
  const line = plain("li", `${rule.label} (${rule.vendorId}:${rule.productId}${rule.serial ? ` ${rule.serial}` : ""})`);
  const toggle = switchControl({
    id: `reach-usb-on-${rule.id}`,
    checked: rule.enabled,
    onChange: (checked) => act(status, () => api("reach/usb/enable", { id: rule.id, on: checked }))()
  });
  const [remove, removeHint] = button(`reach-usb-remove-${rule.id}`, "reach.usb.remove", "Remove", "reach.usb.removeHint", "Forgets this device.",
    act(status, () => api("reach/usb/remove", { id: rule.id })));
  line.append(" ", ...control(`reach-usb-on-${rule.id}`, "reach.usb.on", "On", "reach.usb.onHint", "Starts the task when this device is plugged in.", toggle), remove, removeHint);
  return line;
}

async function usbCard(state) {
  const { node, status } = card("reach-usb-card", "settings:computer", "reach.usb.title", "Starting a task when a USB device is plugged in",
    "reach.usb.purpose", "Name a device and what to do when it is plugged in. Each device starts switched off; switch it on here when you are ready.");
  node.append(...switchFor("usb", state.modes, status));
  if (state.modes.usb !== "off") {
    const vendor = field(""), product = field(""), serial = field(""), label = field(""), prompt = field("", "area");
    const found = document.createElement("ul");
    const [look, lookHint] = button("reach-usb-look", "reach.usb.look", "Show plugged-in devices", "reach.usb.lookHint", "Lists what is plugged in now; pick one to fill in the form.",
      attempt(status, async () => {
        const { devices } = await api("reach/usb/devices", {});
        found.replaceChildren(...devices.map((d, i) => {
          const [use, useHint] = button(`reach-usb-use-${i}`, "reach.usb.use", "Use this device", "reach.usb.useHint", "Fills in the form below.", async () => {
            vendor.value = d.vendorId; product.value = d.productId; serial.value = d.serial; label.value = d.name;
          });
          const item = plain("li", `${d.name || "?"} (${d.vendorId}:${d.productId})`);
          item.append(" ", use, useHint);
          return item;
        }));
      }));
    const [save, saveHint] = button("reach-usb-save", "reach.usb.save", "Add the device", "reach.usb.saveHint", "Adds it switched off.",
      act(status, () => api("reach/usb/rules", { id: crypto.randomUUID(), vendorId: vendor.value, productId: product.value, serial: serial.value, label: label.value, prompt: prompt.value })));
    node.append(list(state.usb.map((rule) => usbRule(rule, status))), row(look, lookHint), found,
      ...control("reach-usb-vendor", "reach.usb.vendor", "Vendor id", "reach.usb.vendorHint", "Four hexadecimal digits.", vendor),
      ...control("reach-usb-product", "reach.usb.product", "Product id", "reach.usb.productHint", "Four hexadecimal digits.", product),
      ...control("reach-usb-serial", "reach.usb.serial", "Serial number", "reach.usb.serialHint", "Leave empty for any device of this kind.", serial),
      ...control("reach-usb-label", "reach.usb.label", "Name", "reach.usb.labelHint", "How you call this device.", label),
      ...control("reach-usb-prompt", "reach.usb.prompt", "What to do", "reach.usb.promptHint", "The task that starts, held by your approval rules like a timed job.", prompt),
      row(save, saveHint));
  }
  node.append(status);
  return node;
}

/* ---------- settings:models:media — making videos ---------- */
async function videoCard(state) {
  const { node, status } = card("reach-video-card", "settings:models:media", "reach.video.title", "Making videos",
    "reach.video.purpose", "Short videos from a description, through OpenAI's or Google's video service and your own key. Each video costs money at that service.");
  node.append(...switchFor("video", state.modes, status));
  if (state.modes.video !== "off") {
    const service = choice([["openai", "", "OpenAI"], ["google", "", "Google"]], state.video.service);
    const secret = field(state.video.secret), model = field(state.video.model), perDay = field(String(state.video.perDay ?? 3), "number");
    perDay.min = "1"; perDay.max = "50";
    // A key name belongs to one service: choosing the other one empties it, so its usual key is used.
    service.addEventListener("change", () => { secret.value = ""; model.value = ""; });
    const [save, saveHint] = button("reach-video-save", "reach.saveButton", "Save", "reach.video.saveHint", "Keeps which service and key to use.",
      attempt(status, async () => {
        await api("reach/video/settings", { service: service.value, secret: secret.value.trim(), model: model.value.trim(), perDay: Number(perDay.value) || 1 });
        done(status);
      }));
    node.append(...control("reach-video-service", "reach.video.service", "Service", "reach.video.serviceHint", "Where the video is made.", service),
      ...control("reach-video-secret", "reach.video.secret", "Key name in Secrets", "reach.video.secretHint", "The name of the saved secret holding the key; leave empty for OPENAI_API_KEY or GEMINI_API_KEY. The key itself never leaves Secrets.", secret),
      ...control("reach-video-per-day", "reach.video.perDay", "Videos a day, at most", "reach.video.perDayHint", "Counted before the service is asked; a practice run does not count.", perDay),
      ...control("reach-video-model", "reach.video.model", "Model", "reach.video.modelHint", "Leave empty for the service's usual video model.", model),
      row(save, saveHint));
  }
  node.append(status);
  return node;
}

/* ---------- settings:channels — the relay ---------- */
async function relayCard(state) {
  const { node, status } = card("reach-relay-card", "settings:channels", "reach.relay.title", "A relay that holds your chat app accounts",
    "reach.relay.purpose", "Your chat app accounts live on a relay you run; every message between it and Branch is sealed end to end. Branch only answers chats that wrote to it first.");
  node.append(...switchFor("relay", state.modes, status));
  if (state.modes.relay !== "off") {
    const r = state.relay;
    const address = field(r.address, "url"), relayId = field(r.relayId), secret = field(r.secret), platforms = field(r.platforms.join(", "));
    const [save, saveHint] = button("reach-relay-save", "reach.saveButton", "Save", "reach.relay.saveHint", "Keeps the relay's address and pairing.",
      act(status, () => api("reach/relay/settings", { address: address.value.trim(), relayId: relayId.value.trim(), secret: secret.value.trim(),
        platforms: platforms.value.split(",").map((p) => p.trim()).filter(Boolean) })));
    node.append(...control("reach-relay-address", "reach.relay.address", "Relay address", "reach.relay.addressHint", "An https address.", address),
      ...control("reach-relay-id", "reach.relay.id", "Relay id", "reach.relay.idHint", "As the relay's own setup shows it.", relayId),
      ...control("reach-relay-secret", "reach.relay.secret", "Pairing secret name in Secrets", "reach.relay.secretHint", "A saved secret of at least 32 random bytes, the same on the relay.", secret),
      ...control("reach-relay-platforms", "reach.relay.platforms", "Chat apps it may bring", "reach.relay.platformsHint", "Separated by commas, for example telegram, slack.", platforms),
      row(save, saveHint),
      plain("p", `${r.machineId || "—"} · ${r.health.state} · ${r.refused} · ${r.chats}`, "subtle"),
      make("p", "subtle", "reach.relay.statusHint", "This computer's id at the relay, the connection, messages refused, and chats known."));
  }
  node.append(status);
  return node;
}

/* ---------- settings:channels — sending and pausing ---------- */
function ownerRow(account, accounts, status) {
  const item = plain("li", `${account.channel}: ${account.sender}`);
  const [remove, hint] = button(`reach-owner-remove-${account.channel}-${account.sender}`.replace(/[^\w-]/g, "_"), "reach.usb.remove", "Remove",
    "reach.chats.ownerRemoveHint", "This account can no longer pause chat apps.",
    act(status, () => api("reach/platforms/owners", { owners: accounts.filter((a) => a !== account) })));
  item.append(" ", remove, hint);
  return item;
}

async function chatsCard(state) {
  const { node, status } = card("reach-chats-card", "settings:channels", "reach.chats.title", "Sending and pausing chat apps",
    "reach.chats.purpose", "Send a script's output to a chat with: branch send <chat app> <chat>. Pause a chat app here, or from your own account with /platform pause.");
  node.append(...switchFor("send", state.modes, status), ...switchFor("platform-pause", state.modes, status));
  if (state.modes["platform-pause"] !== "off") {
    const paused = new Set(state.platforms.paused);
    for (const channel of state.channels) {
      const box = switchControl({
        id: `reach-pause-${channel}`.replace(/[^\w-]/g, "_"),
        checked: paused.has(channel),
        onChange: (checked) => act(status, () => api("reach/platforms/pause", { channel, paused: checked }))()
      });
      const [label, element, hint] = control(`reach-pause-${channel}`.replace(/[^\w-]/g, "_"), "reach.chats.paused", "Paused", "reach.chats.pausedHint", "Its messages are let go without an answer.", box);
      node.append(row(plain("span", channel), label, element), hint);
    }
    const channel = field(""), sender = field("");
    const owners = state.platforms.owners;
    const [add, addHint] = button("reach-owner-add", "reach.chats.ownerAdd", "Add my account", "reach.chats.ownerAddHint", "Only this exact account, in a direct chat, may pause or resume.",
      act(status, () => api("reach/platforms/owners", { owners: [...owners, { channel: channel.value.trim(), sender: sender.value.trim() }] })));
    node.append(make("h3", "", "reach.chats.owners", "My own chat accounts"), list(owners.map((a) => ownerRow(a, owners, status))),
      ...control("reach-owner-channel", "reach.chats.channel", "Chat app", "reach.chats.channelHint", "As it is named under Connections.", channel),
      ...control("reach-owner-sender", "reach.chats.sender", "My id there", "reach.chats.senderHint", "Your own sender id in that app; never everybody.", sender),
      row(add, addHint));
  }
  node.append(status);
  return node;
}

/* ---------- settings:skills — sharing through git ---------- */
function sourceRow(source, status) {
  const item = plain("li", `${source.url} (${source.ref}) ${source.commit.slice(0, 8)}`);
  const [update, updateHint] = button(`reach-git-update-${source.id}`, "reach.git.update", "Update", "reach.git.updateHint", "Brings in a newer version; what you changed is kept.",
    act(status, () => api("reach/git/update", { id: source.id })));
  const [remove, removeHint] = button(`reach-git-remove-${source.id}`, "reach.usb.remove", "Remove", "reach.git.removeHint", "Stops following this repository; nothing it brought is removed.",
    act(status, () => api("reach/git/remove", { id: source.id })));
  item.append(" ", update, updateHint, remove, removeHint);
  return item;
}

async function shareCard(state) {
  const { node, status } = card("reach-share-card", "settings:skills", "reach.git.title", "Sharing the assistant through git",
    "reach.git.purpose", "Write your specialists, procedures and skills into a folder you can commit, or follow somebody's repository. Rules, model choices, memory and secrets never travel.");
  node.append(...switchFor("agent-git", state.modes, status));
  if (state.modes["agent-git"] !== "off") {
    const folder = field("shared-assistant"), url = field("", "url"), ref = field("main"), inside = field("");
    const [publish, publishHint] = button("reach-git-publish", "reach.git.publish", "Write the files", "reach.git.publishHint", "Writes them into that workspace folder; nothing is pushed.",
      attempt(status, async () => { await api("reach/git/publish", { folder: folder.value.trim() }); done(status); }));
    const [install, installHint] = button("reach-git-install", "reach.git.install", "Bring it in", "reach.git.installHint", "New skills arrive switched off.",
      act(status, () => api("reach/git/install", { url: url.value.trim(), ref: ref.value.trim() || "main", folder: inside.value.trim() })));
    node.append(...control("reach-git-folder", "reach.git.folder", "Workspace folder", "reach.git.folderHint", "Where the shared files are written.", folder),
      row(publish, publishHint),
      ...control("reach-git-url", "reach.git.url", "Repository address", "reach.git.urlHint", "An https address, with no name or password in it.", url),
      ...control("reach-git-ref", "reach.git.ref", "Branch or tag", "reach.git.refHint", "Usually main.", ref),
      ...control("reach-git-inside", "reach.git.inside", "Folder in the repository", "reach.git.insideHint", "Leave empty when the files are at the top.", inside),
      row(install, installHint), list(state.git.map((s) => sourceRow(s, status))));
  }
  node.append(status);
  return node;
}

/* ---------- settings:skills — bundles ---------- */
async function bundlesCard(state) {
  const { node, status } = card("reach-bundles-card", "settings:skills", "reach.bundles.title", "Skill bundles",
    "reach.bundles.purpose", "Several skills in one file, to hand on or bring in. Every skill that arrives is checked and starts switched off.");
  node.append(...switchFor("skill-bundles", state.modes, status));
  if (state.modes["skill-bundles"] !== "off") {
    const skills = ((await api("state")).skills ?? []).filter((s) => s.activeVersion !== null);
    const skillsGroup = document.createElement("fieldset");
    const skillsTitle = make("legend", "", "reach.bundles.skills", "Skills to bundle");
    const skillsHint = make("p", "field-note", "reach.bundles.skillsHint", "Only switched-on skills can be bundled.");
    skillsHint.id = "reach-bundles-skills-hint";
    skillsGroup.append(skillsTitle, skillsHint);
    const skillSwitches = [];
    for (const s of skills) {
      const sw = switchControl({
        id: `reach-bundle-skill-${s.id}`,
        checked: false,
      });
      sw.setAttribute("aria-describedby", skillsHint.id);
      const skillRow = document.createElement("label");
      skillRow.className = "check-row";
      skillRow.append(sw, " ", plain("span", s.name));
      skillsGroup.append(skillRow);
      skillSwitches.push({ id: s.id, control: sw });
    }
    node.append(skillsGroup);
    const name = field(""), path = field("bundles/my-skills.branch-skills"), source = field("");
    const shown = document.createElement("div");
    const where = () => (/^https:/i.test(source.value.trim()) ? { url: source.value.trim() } : { path: source.value.trim() });
    const [write, writeHint] = button("reach-bundles-write", "reach.bundles.write", "Write the bundle", "reach.bundles.writeHint", "Writes the chosen skills into that workspace file.",
      attempt(status, async () => { await api("reach/bundles/write", { name: name.value.trim(), path: path.value.trim(), skills: skillSwitches.filter((s) => s.control.checked).map((s) => s.id) }); done(status); }));
    const [look, lookHint] = button("reach-bundles-look", "reach.bundles.look", "Look inside", "reach.bundles.lookHint", "Installs nothing.",
      attempt(status, async () => { const b = await api("reach/bundles/preview", where()); shown.replaceChildren(plain("p", b.name), list(b.skills.map((s) => plain("li", s.name)))); }));
    const [install, installHint] = button("reach-bundles-install", "reach.git.install", "Bring it in", "reach.bundles.installHint", "Each skill starts switched off; one you already have is left alone.",
      attempt(status, async () => { await api("reach/bundles/install", where()); done(status); }));
    node.append(...control("reach-bundles-name", "reach.bundles.name", "Bundle name", "reach.bundles.nameHint", "Shown to whoever opens it.", name),
      ...control("reach-bundles-path", "reach.bundles.path", "Workspace file", "reach.bundles.pathHint", "Ends in .branch-skills.", path),
      row(write, writeHint),
      ...control("reach-bundles-source", "reach.bundles.source", "Bundle to bring in", "reach.bundles.sourceHint", "A workspace file or an https address.", source),
      row(look, lookHint, install, installHint), shown);
  }
  node.append(status);
  return node;
}

/* ---------- library:documents — notes ---------- */
const STYLES = [["clearer", "reach.notes.clearer", "Clearer"], ["shorter", "reach.notes.shorter", "Shorter"], ["fix", "reach.notes.fix", "Fix spelling"],
  ["list", "reach.notes.list", "As a list"], ["formal", "reach.notes.formal", "More formal"]];
let openNote = null;

async function notesCard(state) {
  const { node, status } = card("reach-notes-card", "library:documents", "reach.notes.title", "Notes",
    "reach.notes.purpose", "Short notes of your own. Branch can suggest a rewrite; the note only changes when you keep it.");
  node.append(...switchFor("notes", state.modes, status));
  if (state.modes.notes !== "off") {
    const { notes } = await api("reach/notes");
    const current = notes.find((n) => n.id === openNote) ?? null;
    const title = field(current?.title ?? ""), body = field(current?.body ?? "", "area");
    const style = choice(STYLES, "clearer");
    const suggestion = document.createElement("div");
    const picks = notes.map((n) => {
      const [open, hint] = button(`reach-note-${n.id}`, "", "", "reach.notes.openHint", "Opens this note.", async () => { openNote = n.id; await drawCards(); });
      delete open.dataset.t;
      open.textContent = n.title;
      const item = document.createElement("li");
      item.append(open, hint);
      return item;
    });
    const save = (text) => api("reach/notes", { ...(current ? { id: current.id, expected: current.updatedAt } : {}), title: title.value.trim(), body: text });
    const [keep, keepHint] = button("reach-notes-save", "reach.saveButton", "Save", "reach.notes.saveHint", "Keeps the note.",
      act(status, async () => { openNote = (await save(body.value)).note.id; }));
    const [fresh, freshHint] = button("reach-notes-new", "reach.notes.new", "New note", "reach.notes.newHint", "Starts an empty note.", async () => { openNote = null; await drawCards(); });
    const [rewrite, rewriteHint] = button("reach-notes-rewrite", "reach.notes.rewrite", "Suggest a rewrite", "reach.notes.rewriteHint", "Asks the model; nothing is saved yet.",
      attempt(status, async () => {
        if (!current) throw new Error(say("reach.notes.saveFirst", "Save the note first."));
        const answer = await api("reach/notes/rewrite", { id: current.id, style: style.value });
        const [use, useHint] = button("reach-notes-keep", "reach.notes.keep", "Keep this version", "reach.notes.keepHint", "Replaces the note with the suggestion.",
          act(status, () => save(answer.suggestion)));
        suggestion.replaceChildren(plain("pre", answer.suggestion), row(use, useHint));
      }));
    node.append(list(picks), row(fresh, freshHint),
      ...control("reach-notes-title", "reach.notes.noteTitle", "Title", "reach.notes.titleHint", "A few words.", title),
      ...control("reach-notes-body", "reach.notes.body", "Note", "reach.notes.bodyHint", "Plain text.", body),
      row(keep, keepHint),
      ...control("reach-notes-style", "reach.notes.style", "Rewrite style", "reach.notes.styleHint", "How the suggestion should differ.", style),
      row(rewrite, rewriteHint), suggestion);
  }
  node.append(status);
  return node;
}

/* ---------- settings:models:second — arena ---------- */
async function arenaCard(state) {
  const { node, status } = card("reach-arena-card", "settings:models:second", "reach.arena.title", "Model arena",
    "reach.arena.purpose", "Two of your model connections answer the same question without their names. Pick the better answer; the names and the leaderboard are shown after.");
  node.append(...switchFor("arena", state.modes, status));
  if (state.modes.arena !== "off") {
    const { leaderboard } = await api("reach/arena");
    const prompt = field("", "area");
    const round = columns();
    const verdict = document.createElement("div");
    const vote = (id, winner, key, english, hint) => button(`reach-arena-${winner}`, key, english, `reach.arena.${winner}Hint`, hint,
      act(status, async () => { const r = await api("reach/arena/vote", { id, winner }); status.textContent = `A: ${r.a} · B: ${r.b}`; }));
    const [ask, askHint] = button("reach-arena-ask", "reach.arena.ask", "Ask two models", "reach.arena.askHint", "Each answer uses that connection as usual.",
      attempt(status, async () => {
        const r = await api("reach/arena/start", { prompt: prompt.value });
        round.replaceChildren(plain("pre", `A\n${r.answers.a}`), plain("pre", `B\n${r.answers.b}`));
        verdict.replaceChildren(row(vote(r.id, "a", "reach.arena.a", "A is better", "A wins this round."), vote(r.id, "b", "reach.arena.b", "B is better", "B wins this round."),
          vote(r.id, "tie", "reach.arena.tie", "A tie", "Both are as good."), vote(r.id, "both-bad", "reach.arena.bad", "Both are bad", "Nobody's rating changes.")));
      }));
    const table = list(leaderboard.map((e) => plain("li", `${e.name}: ${e.rating} (${e.games})`)));
    node.append(...control("reach-arena-prompt", "reach.arena.prompt", "Question", "reach.arena.promptHint", "The same question goes to both.", prompt),
      row(ask, askHint), round, verdict, make("h3", "", "reach.arena.leaderboard", "Leaderboard"), table);
  }
  node.append(status);
  return node;
}

const BUILDERS = [
  ["reach-machines-card", machinesCard], ["reach-background-card", backgroundCard], ["reach-usb-card", usbCard],
  ["reach-trunks-card", trunksCard], ["reach-video-card", videoCard], ["reach-relay-card", relayCard],
  ["reach-chats-card", chatsCard], ["reach-share-card", shareCard], ["reach-bundles-card", bundlesCard],
  ["reach-notes-card", notesCard], ["reach-arena-card", arenaCard],
];

async function drawCards() {
  let state;
  try { state = await api("reach"); } catch { return; }
  for (const [id, build] of BUILDERS) {
    try {
      const fresh = await build(state);
      const old = $(id);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
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

whenReady(() => { void drawCards(); });
