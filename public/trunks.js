/* R17-A (wave mac7): Trunks, the owner's named assistants. Every part has the three-way switch and
   starts off; nothing below shows until Trunks are switched on.

   customize:specialists   the Trunks card: switches, the three-field create, each Trunk's editor,
                           rooms, bringing one in from a file or from Specialists
   the sidebar             the roster, above Recents: each Trunk with its latest line, when, and
                           how many replies are unread; each room with "needs you"
   inbox:needs             rooms where a Trunk asked for you
   the message box         "@" offers the Trunks; "@name message" goes to that Trunk

   Placed through data-home (public/layout.js); colours only through tokens. */
import { api, displayView, openConversation } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english.replace(/\{(\w+)\}/g, (w, n) => (values && n in values ? String(values[n]) : w)) : word; };
function make(tag, className, key, english, values) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english, values); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function field(tag, value = "", type = "") {
  const node = document.createElement(tag);
  if (type) node.type = type;
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value ?? "";
  return node;
}
function labelled(id, key, english, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function tick(id, key, english, checked) {
  const label = document.createElement("label");
  const box = field("input", checked, "checkbox");
  box.id = id;
  label.append(box, " ", make("span", "", key, english));
  return { label, box };
}
function button(key, english, handler, quiet = true) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { report(error); } finally { node.disabled = false; }
  });
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}
let statusLine = null;
function report(error) {
  if (!statusLine) return;
  delete statusLine.dataset.t;
  statusLine.textContent = error?.message ?? String(error);
}
const saved = () => { if (statusLine) { statusLine.dataset.t = "trunks.saved"; statusLine.textContent = say("trunks.saved", "Saved."); } };
const list = (text) => text.split(",").map((part) => part.trim()).filter(Boolean);

/* ---------- a Trunk's face: drawn from its name, coloured by a series token ---------- */
const SVG = "http://www.w3.org/2000/svg";
function shape(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    // phase2/rooms (integration review): the window's content rules refuse a `style` attribute, so every
    // drawn face (the sidebar's too) came out black; the same colours set through the element's own style are allowed.
    if (name === "style") for (const line of String(value).split(";")) {
      const at = line.indexOf(":");
      if (at > 0) node.style.setProperty(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    else node.setAttribute(name, String(value));
  }
  return node;
}
function hash(text) {
  let value = 2166136261;
  for (const char of (text || "trunk").trim().toLowerCase()) value = Math.imul(value ^ char.codePointAt(0), 16777619) >>> 0;
  return value;
}
export function avatar(trunk, size = 28) {
  const kind = trunk.avatar?.kind ?? "face";
  if (kind !== "face") {
    const img = document.createElement("img");
    img.src = trunk.avatar.dataUrl;
    img.alt = "";
    img.width = size; img.height = size;
    img.className = "trunk-face";
    return img;
  }
  const seed = hash(trunk.avatar?.seed || trunk.name);
  const svg = shape("svg", { viewBox: "0 0 32 32", width: size, height: size, "aria-hidden": "true", class: "trunk-face" });
  const head = seed % 4, eyes = (seed >>> 3) % 4, mouth = (seed >>> 6) % 4, series = ((seed >>> 9) % 8) + 1; // phase2/rooms: >>> (the seed is unsigned; >> made half the faces colourless)
  const fill = `var(--series-${series})`;
  svg.append(head % 2 ? shape("rect", { x: 3, y: 3, width: 26, height: 26, rx: 6 + head * 2, style: `fill:${fill}` }) : shape("circle", { cx: 16, cy: 16, r: 13, style: `fill:${fill}` }));
  const eye = { style: "fill:var(--ground)" };
  for (const x of [11, 21]) svg.append(eyes % 2 ? shape("circle", { cx: x, cy: 13, r: 1.5 + eyes / 2, ...eye }) : shape("rect", { x: x - 2, y: 12, width: 4, height: 2 + eyes, rx: 1, ...eye }));
  const curve = ["M11 20 Q16 24 21 20", "M11 21 H21", "M12 20 Q16 23 20 20 Q16 22 12 20", "M13 21 Q16 19 19 21"][mouth];
  svg.append(shape("path", { d: curve, style: "fill:none;stroke:var(--ground);stroke-width:1.8;stroke-linecap:round" }));
  if (trunk.working) svg.animate([{ transform: "translateY(0)" }, { transform: "translateY(-2px)" }, { transform: "translateY(0)" }], { duration: 900, iterations: Infinity });
  return svg;
}

/* ---------- the switches ---------- */
const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "Only when it is needed"]];
const PARTS = {
  trunks: ["trunks.part.trunks", "Trunks"],
  rooms: ["trunks.part.rooms", "Rooms where Trunks talk together"],
  messages: ["trunks.part.messages", "Trunks messaging each other"],
  routines: ["trunks.part.routines", "Routines a Trunk owns"],
  teach: ["trunks.part.teach", "Teaching a Trunk by showing it once"],
  conversations: ["trunks.part.conversations", "Choosing a Trunk to answer in any conversation"], // phase2/rooms
};
function switchFor(part, modes) {
  const select = document.createElement("select");
  for (const [value, key, english] of POSITIONS) {
    const option = make("option", "", key, english);
    option.value = value;
    option.selected = value === modes[part];
    select.append(option);
  }
  select.addEventListener("change", async () => {
    try { await api("trunks/switch", { part, mode: select.value }); saved(); await draw(); } catch (error) { report(error); }
  });
  const [key, english] = PARTS[part];
  return labelled(`trunks-switch-${part}`, key, english, select);
}

/* ---------- create: three fields ---------- */
function createForm() {
  const form = document.createElement("form");
  form.id = "trunks-create";
  const name = field("input"), title = field("input"), description = field("textarea");
  name.required = true; name.maxLength = 40; title.maxLength = 80; description.maxLength = 1000; description.rows = 2;
  const create = make("button", "", "trunks.create", "Create the Trunk");
  create.type = "submit";
  form.append(make("h3", "", "trunks.new", "A new Trunk"),
    ...labelled("trunks-new-name", "trunks.field.name", "Name", name),
    ...labelled("trunks-new-title", "trunks.field.title", "What it does, in a few words", title),
    ...labelled("trunks-new-description", "trunks.field.description", "About it", description),
    make("p", "field-note", "trunks.create.note", "It introduces itself in its own conversation. Everything else can be changed later."), create);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("trunks", { name: name.value.trim(), title: title.value.trim(), description: description.value.trim() });
      form.reset();
      saved();
      await draw();
    } catch (error) { report(error); }
  });
  return form;
}

/* ---------- one Trunk in the list ---------- */
async function openChat(trunk) {
  displayView("chat");
  await openConversation(trunk.chatSessionId);
  await api(`trunks/${trunk.id}/seen`, {}).catch(() => undefined);
  void drawRail();
}
function trunkRow(trunk) {
  const item = document.createElement("li");
  item.className = "trunk-row";
  item.dataset.trunk = trunk.id;
  const words = plain("span", `${trunk.name} (@${trunk.handle})${trunk.title ? ` — ${trunk.title}` : ""}`);
  item.append(avatar(trunk), " ", words, " ",
    button("trunks.talk", "Talk", () => openChat(trunk)), " ",
    button("trunks.edit", "Edit Trunk", () => openEditor(trunk.id)), " ",
    button("trunks.remove", "Remove", async () => {
      if (!confirm(say("trunks.remove.confirm", "Remove {name}? Its conversations stay in your history.", { name: trunk.name }))) return;
      await api(`trunks/${trunk.id}/remove`, {});
      await draw();
    }));
  return item;
}

/* ---------- Edit Trunk: every field ---------- */
const STYLES = [["default", "trunks.style.default", "The ordinary way"], ["react", "trunks.style.react", "Thinks out loud"], ["plan-execute", "trunks.style.plan", "Plans first"],
  ["critic", "trunks.style.critic", "Reviews without changing anything"], ["researcher", "trunks.style.researcher", "Looks things up"], ["coder", "trunks.style.coder", "Writes code"]];
function select(options, value) {
  const node = document.createElement("select");
  for (const [option, key, english] of options) {
    const entry = make("option", "", key, english);
    entry.value = option;
    entry.selected = option === value;
    node.append(entry);
  }
  return node;
}
function editorFields(trunk) {
  const f = {
    name: field("input", trunk.name), title: field("input", trunk.title), description: field("textarea", trunk.description),
    model: field("input", trunk.model), instructions: field("textarea", trunk.instructions), permissions: field("input", trunk.permissions.join(", ")),
    skills: field("input", trunk.skills.join(", ")), mcp: field("input", trunk.mcpServers.join(", ")), section: field("input", trunk.section),
    channels: field("input", trunk.reach.channels.join(", ")),
    reasoning: select([["", "trunks.reasoning.default", "The model's own"], ["low", "trunks.reasoning.low", "Low"], ["medium", "trunks.reasoning.medium", "Medium"], ["high", "trunks.reasoning.high", "High"]], trunk.reasoning ?? ""),
    style: select(STYLES, trunk.style),
  };
  f.instructions.rows = 5;
  return f;
}
function editorTicks(trunk) {
  return {
    shared: tick("trunks-edit-shared", "trunks.field.sharedFacts", "Also reads the facts you marked as shared", trunk.sharedFacts),
    copy: tick("trunks-edit-copy", "trunks.field.copyKeys", "Uses copies of your keys (sign-ins are never copied)", trunk.keys.copyFromOwner),
    commands: tick("trunks-edit-commands", "trunks.field.commands", "May run commands on this computer", trunk.reach.commands),
    hidden: tick("trunks-edit-hidden", "trunks.field.hidden", "Hide it from the sidebar", trunk.hidden),
    pinned: tick("trunks-edit-pinned", "trunks.field.pinned", "Pin it to the top", trunk.pinned),
  };
}
function editorValues(trunk, f, ticks) {
  return { name: f.name.value.trim(), title: f.title.value.trim(), description: f.description.value.trim(), model: f.model.value.trim(),
    reasoning: f.reasoning.value || null, instructions: f.instructions.value, style: f.style.value, permissions: list(f.permissions.value),
    skills: list(f.skills.value), mcpServers: list(f.mcp.value), section: f.section.value.trim(), sharedFacts: ticks.shared.box.checked,
    keys: { copyFromOwner: ticks.copy.box.checked, accounts: trunk.keys.accounts }, reach: { channels: list(f.channels.value), commands: ticks.commands.box.checked },
    hidden: ticks.hidden.box.checked, pinned: ticks.pinned.box.checked };
}
async function openEditor(id) {
  const host = $("trunks-editor");
  if (!host) return;
  const view = await api(`trunks/${id}`);
  const trunk = view.trunk, f = editorFields(trunk), ticks = editorTicks(trunk);
  const labels = [["name", "trunks.field.name", "Name"], ["title", "trunks.field.title", "What it does, in a few words"], ["description", "trunks.field.description", "About it"],
    ["model", "trunks.field.model", "Model (empty: the conversation's, then your default)"], ["reasoning", "trunks.field.reasoning", "How hard it thinks"],
    ["instructions", "trunks.field.instructions", "Its own instructions"], ["style", "trunks.field.style", "How it works"],
    ["permissions", "trunks.field.permissions", "Tools it may use, by permission (empty: your usual set)"], ["skills", "trunks.field.skills", "Skills it reaches for first"],
    ["mcp", "trunks.field.mcp", "Connected tool servers it may use (none by default)"], ["channels", "trunks.field.channels", "Chat apps it answers on (none by default)"],
    ["section", "trunks.field.section", "Sidebar section"]];
  const save = make("button", "", "trunks.save", "Save changes");
  save.type = "button";
  save.addEventListener("click", async () => {
    try { await api(`trunks/${id}`, editorValues(trunk, f, ticks)); saved(); await draw(); await openEditor(id); } catch (error) { report(error); }
  });
  host.replaceChildren(make("h3", "", "trunks.editing", "Edit {name}", { name: trunk.name }),
    ...labels.flatMap(([name, key, english]) => labelled(`trunks-edit-${name}`, key, english, f[name])),
    ...Object.values(ticks).map((entry) => entry.label), save,
    pictureSection(trunk), keysNote(view.keys), routinesSection(trunk, view.routines), teachSection(trunk, view.watching), moreSection(trunk));
  host.hidden = false;
}

function section(key, english) {
  const node = document.createElement("div");
  node.className = "trunk-section";
  node.append(make("h3", "", key, english));
  return node;
}
function pictureSection(trunk) {
  const node = section("trunks.picture", "Picture");
  const upload = field("input", "", "file");
  upload.accept = "image/png,image/jpeg,image/webp";
  upload.addEventListener("change", () => {
    const file = upload.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => { try { await api(`trunks/${trunk.id}/avatar`, { kind: "image", dataUrl: String(reader.result) }); await openEditor(trunk.id); void draw(); } catch (error) { report(error); } };
    reader.readAsDataURL(file);
  });
  const words = field("input");
  const locked = trunk.avatar?.kind === "face" && trunk.avatar.locked;
  node.append(avatar(trunk, 48),
    row(button(locked ? "trunks.picture.unlock" : "trunks.picture.lock", locked ? "Let the face follow the name" : "Keep this face",
      async () => { await api(`trunks/${trunk.id}/avatar`, { kind: "face", locked: !locked }); await openEditor(trunk.id); })),
    ...labelled(`trunks-picture-upload`, "trunks.picture.upload", "Use a picture of your own", upload),
    ...labelled(`trunks-picture-words`, "trunks.picture.words", "Or describe one for the picture model", words),
    row(button("trunks.picture.make", "Make it", async () => {
      await api(`trunks/${trunk.id}/avatar`, { kind: "generate", prompt: words.value.trim() });
      await openEditor(trunk.id);
      void draw();
    })));
  return node;
}
function keysNote(keys) {
  const node = section("trunks.keys", "Keys and accounts");
  if (keys.note) node.append(make("p", "subtle", "trunks.keys.pending", "Several accounts per connection are switched off, so this Trunk uses your own keys."));
  for (const note of keys.plan.notes) node.append(plain("p", note, "field-note"));
  return node;
}
function routinesSection(trunk, routines) {
  const node = section("trunks.routines", "Routines");
  for (const routine of routines)
    node.append(row(plain("span", `${routine.name}${routine.dailyAt ? ` · ${routine.dailyAt}` : ""} · ${routine.status}`),
      button("trunks.remove", "Remove", async () => { await api(`trunks/routines/${routine.id}/remove`, {}); await openEditor(trunk.id); })));
  const name = field("input"), prompt = field("textarea"), time = field("input", "08:00", "time");
  node.append(...labelled("trunks-routine-name", "trunks.routine.name", "Name", name),
    ...labelled("trunks-routine-prompt", "trunks.routine.prompt", "What it should do", prompt),
    ...labelled("trunks-routine-time", "trunks.routine.time", "Every day at", time),
    row(button("trunks.routine.add", "Add the routine", async () => {
      await api(`trunks/${trunk.id}/routines`, { name: name.value.trim(), prompt: prompt.value.trim(), dailyAt: time.value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await openEditor(trunk.id);
    })));
  return node;
}
function teachSection(trunk, watching) {
  const node = section("trunks.teach", "Teach it by showing");
  node.append(make("p", "subtle", "trunks.teach.how", "Press Watch me, do the job once in any conversation, then save what you did as this Trunk's workflow."));
  const name = field("input"), time = field("input", "", "time");
  const save = async () => {
    const result = await api(`trunks/${trunk.id}/teach`, { name: name.value.trim(), ...(time.value ? { dailyAt: time.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) });
    if (statusLine) { delete statusLine.dataset.t; statusLine.textContent = say("trunks.teach.saved", "Saved \"{name}\" with {steps} steps.", { name: result.workflow.name, steps: result.steps }); }
    await openEditor(trunk.id);
  };
  if (watching) node.append(make("p", "field-note", "trunks.teach.watching", "Watching since you pressed Watch me."),
    ...labelled("trunks-teach-name", "trunks.teach.name", "Name the workflow", name),
    ...labelled("trunks-teach-time", "trunks.teach.time", "Repeat it every day at (optional)", time),
    row(button("trunks.teach.save", "Save what I did", save)));
  else node.append(row(button("trunks.teach.watch", "Watch me", async () => { await api(`trunks/${trunk.id}/watch`, {}); await openEditor(trunk.id); })));
  for (const lesson of trunk.taught) node.append(plain("p", lesson.name, "field-note"));
  return node;
}
function moreSection(trunk) {
  const node = section("trunks.more", "Its conversation and its file");
  node.append(row(
    button("trunks.retire", "Start a fresh conversation", async () => { await api(`trunks/${trunk.id}/retire`, {}); saved(); await draw(); }),
    button("trunks.export", "Save as a file", async () => {
      const file = await api(`trunks/${trunk.id}/export`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
      link.download = `${trunk.handle}.trunk.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    })),
    make("p", "field-note", "trunks.export.note", "The file holds who it is, never its conversations, memory, keys or reach."));
  return node;
}

/* ---------- rooms ---------- */
let roomTimer = null;
function roomsSection(roster) {
  const node = section("trunks.rooms", "Rooms");
  node.append(make("p", "subtle", "trunks.rooms.purpose", "Two to six Trunks and you in one conversation. Only those you @mention answer; nobody mentioned means everyone."));
  for (const room of roster.rooms)
    node.append(row(plain("span", `${room.name}${room.needsYou ? ` · ${say("trunks.needsYou", "needs you")}` : ""}`),
      button("trunks.room.open", "Open", () => openRoom(room.id))));
  const name = field("input");
  const picks = roster.trunks.map((trunk) => {
    const entry = tick(`trunks-room-pick-${trunk.id}`, "", "", false);
    entry.label.append(plain("span", trunk.name));
    entry.box.value = trunk.id;
    return entry;
  });
  node.append(...labelled("trunks-room-name", "trunks.room.name", "Room name", name), ...picks.map((entry) => entry.label),
    row(button("trunks.room.create", "Open a room", async () => {
      const room = await api("trunks/rooms", { name: name.value.trim(), members: picks.filter((p) => p.box.checked).map((p) => p.box.value) });
      await draw();
      await openRoom(room.room.id);
    })));
  return node;
}
function roomLine(view, event, composer) {
  const member = view.roster.find((m) => m.id === event.memberId);
  const who = event.kind === "user" ? say("trunks.room.you", "You") : `@${member?.handle ?? "?"}`;
  const text = event.kind === "pass" ? say("trunks.room.passed", "(passed)") : event.text;
  const line = plain("li", `${who}: ${text}`, event.kind === "failed" ? "field-note" : "");
  if (event.kind === "member" && member) {
    const reply = button("trunks.room.reply", "Reply to @{handle}", () => { composer.value = `@${member.handle} `; composer.focus(); });
    reply.textContent = say("trunks.room.reply", "Reply to @{handle}", { handle: member.handle });
    delete reply.dataset.t; // the @name is part of the words, so a language change must not put the placeholder back
    line.append(" ", reply);
  }
  return line;
}
async function openRoom(id) {
  if (globalThis.branchOpenRoom?.(id)) return; // phase2/rooms: a room opens as a conversation (public/rooms.js)
  const host = $("trunks-room");
  if (!host) return;
  clearTimeout(roomTimer);
  const view = await api(`trunks/rooms/${id}`);
  const composer = field("textarea");
  composer.rows = 2;
  const transcript = document.createElement("ol");
  transcript.className = "trunk-room-log";
  transcript.append(...view.events.filter((e) => e.kind !== "stopped").map((event) => roomLine(view, event, composer)));
  const questions = view.waiting.map((ask) => row(plain("span", `@${view.roster.find((m) => m.id === ask.memberId)?.handle}: ${ask.label || ask.tool}`),
    button("trunks.room.allow", "Allow", async () => { await api(`trunks/rooms/${id}/answer`, { memberId: ask.memberId, decision: "allow", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) }); await openRoom(id); }),
    button("trunks.room.deny", "Deny", async () => { await api(`trunks/rooms/${id}/answer`, { memberId: ask.memberId, decision: "deny", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) }); await openRoom(id); })));
  const send = make("button", "", "trunks.room.send", "Send");
  send.type = "button";
  send.addEventListener("click", async () => {
    if (!composer.value.trim()) return;
    try { await api(`trunks/rooms/${id}/send`, { text: composer.value.trim() }); composer.value = ""; await openRoom(id); } catch (error) { report(error); }
  });
  host.replaceChildren(plain("h3", view.name), plain("p", view.roster.map((m) => `@${m.handle}`).join(", "), "field-note"), transcript, ...questions,
    ...labelled("trunks-room-message", "trunks.room.message", "Your message", composer), row(send,
      button("trunks.room.stop", "Stop", async () => { await api(`trunks/rooms/${id}/stop`, {}); await openRoom(id); }),
      button("trunks.room.close", "Close the room", () => { clearTimeout(roomTimer); host.hidden = true; host.replaceChildren(); })));
  host.hidden = false;
  void drawRail();
  if (view.speaking) roomTimer = setTimeout(() => { if (!host.hidden) void openRoom(id); }, 1500);
}

/* ---------- bringing a Trunk in ---------- */
function bringSection() {
  const node = section("trunks.bring", "Bring one in");
  const upload = field("input", "", "file");
  upload.accept = "application/json,.json";
  upload.addEventListener("change", async () => {
    const file = upload.files?.[0];
    if (!file) return;
    try { await api("trunks/import", JSON.parse(await file.text())); saved(); await draw(); } catch (error) { report(error); }
  });
  const specialists = document.createElement("div");
  node.append(...labelled("trunks-import", "trunks.import", "From a Trunk file", upload),
    row(button("trunks.fromSpecialists", "From Specialists", async () => {
      const state = await api("state");
      specialists.replaceChildren(...state.specialists.map((record) => row(plain("span", record.data.definition?.name ?? record.id),
        button("trunks.bringAcross", "Make it a Trunk", async () => { await api("trunks/from-specialist", { specialistId: record.id }); await draw(); }))));
      if (!state.specialists.length) specialists.replaceChildren(make("p", "field-note", "trunks.noSpecialists", "You have no specialists yet."));
    })), specialists);
  return node;
}

/* ---------- the card ---------- */
async function card() {
  const node = make("section", "card");
  node.id = "trunks-card";
  node.dataset.home = "customize:specialists";
  node.append(make("h2", "", "trunks.title", "Trunks"),
    make("p", "", "trunks.purpose", "Assistants of your own, each with a name, its own conversation, memory and settings."));
  statusLine = make("p", "subtle");
  statusLine.setAttribute("role", "status");
  const roster = await api("trunks");
  const modes = roster.modes;
  const switches = document.createElement("div");
  for (const part of Object.keys(PARTS)) if (part === "trunks" || modes.trunks !== "off") switches.append(...switchFor(part, modes));
  node.append(switches);
  if (modes.trunks !== "off") {
    const trunks = document.createElement("ul");
    trunks.id = "trunks-list";
    trunks.append(...roster.trunks.map(trunkRow));
    if (!roster.trunks.length) node.append(make("p", "empty-state", "trunks.empty", "No Trunks yet. Give one a name below and it will introduce itself."));
    const editor = document.createElement("div"), room = document.createElement("div");
    editor.id = "trunks-editor"; editor.hidden = true;
    room.id = "trunks-room"; room.hidden = true;
    node.append(trunks, editor, createForm(), ...(modes.rooms !== "off" ? [roomsSection(roster), room] : []), bringSection());
  }
  node.append(statusLine);
  return node;
}

/* ---------- the roster in the sidebar, above Recents ---------- */
function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return say("trunks.ago.minutes", "{n} min ago", { n: minutes });
  if (minutes < 1440) return say("trunks.ago.hours", "{n} hr ago", { n: Math.round(minutes / 60) });
  return say("trunks.ago.days", "{n} days ago", { n: Math.round(minutes / 1440) });
}
function railTrunk(trunk) {
  const open = document.createElement("button");
  open.type = "button";
  open.className = "rail-row trunk-rail-row";
  open.dataset.trunk = trunk.id;
  const text = document.createElement("span");
  text.append(plain("strong", trunk.name), " ", plain("small", `${trunk.latest ? trunk.latest.text : ""} · ${ago(trunk.at)}`));
  open.append(avatar(trunk, 22), text);
  if (trunk.unread) {
    const badge = plain("span", String(trunk.unread), "rail-badge");
    badge.setAttribute("aria-label", say("trunks.unread", "{n} unread", { n: trunk.unread }));
    open.append(badge);
  }
  open.addEventListener("click", () => { void openChat(trunk); });
  return open;
}
function railRoom(room) {
  const open = document.createElement("button");
  open.type = "button";
  open.className = "rail-row trunk-rail-row";
  open.dataset.room = room.id;
  open.append(plain("span", `# ${room.name}`));
  if (room.needsYou) open.append(make("span", "rail-badge", "trunks.needsYou", "needs you"));
  open.addEventListener("click", async () => { displayView("customize:specialists"); await draw(); await openRoom(room.id); });
  return open;
}
async function drawRail() {
  const recents = document.querySelector('.rail-group[data-group="recents"]');
  let group = $("trunks-rail");
  let roster;
  try { roster = await api("trunks"); } catch { return; }
  if (roster.modes.trunks === "off") { group?.remove(); return; }
  if (!group && recents) {
    group = document.createElement("section");
    group.className = "rail-group";
    group.id = "trunks-rail";
    group.dataset.group = "trunks";
    const head = document.createElement("h2");
    head.append(make("span", "", "trunks.rail", "Trunks"));
    group.append(head, Object.assign(document.createElement("div"), { id: "trunks-rail-rows", className: "rail-rows" }));
    recents.before(group);
  }
  if (!group) return;
  const visible = roster.trunks.filter((trunk) => !trunk.hidden);
  const sections = [...new Set(visible.map((trunk) => trunk.section))];
  const rows = sections.flatMap((name) => [...(name ? [plain("p", name, "rail-empty")] : []), ...visible.filter((trunk) => trunk.section === name).map(railTrunk)]);
  $("trunks-rail-rows").replaceChildren(...rows, ...roster.rooms.map(railRoom));
  if (!rows.length && !roster.rooms.length) $("trunks-rail-rows").append(make("p", "rail-empty", "trunks.rail.empty", "No Trunks yet."));
  drawNeeds(roster.rooms.filter((room) => room.needsYou));
}

/* ---------- Inbox › Needs you: rooms that asked for the owner ---------- */
function drawNeeds(rooms) {
  let node = $("trunks-needs-card");
  if (!rooms.length) { node?.remove(); return; }
  if (!node) {
    node = make("section", "card");
    node.id = "trunks-needs-card";
    node.dataset.home = "inbox:needs";
    document.body.append(node);
  }
  node.replaceChildren(make("h2", "", "trunks.needs.title", "Rooms that need you"),
    make("p", "", "trunks.needs.purpose", "A Trunk asked for you, or is waiting for your yes."),
    ...rooms.map((room) => row(plain("span", room.name), button("trunks.room.open", "Open", async () => { displayView("customize:specialists"); await draw(); await openRoom(room.id); }))));
}

/* ---------- the message box: "@" offers the Trunks, "@name message" goes to that Trunk ---------- */
let known = [];
function mentionAt(box) {
  const before = box.value.slice(0, box.selectionStart ?? box.value.length);
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
  return match ? { word: match[2].toLowerCase(), start: before.length - match[2].length - 1 } : null;
}
function closeMenu() { $("trunks-mentions")?.remove(); }
function showMenu(box) {
  const mention = mentionAt(box);
  const found = mention ? known.filter((trunk) => trunk.handle.startsWith(mention.word) || trunk.name.toLowerCase().startsWith(mention.word)).slice(0, 6) : [];
  if (!found.length) { closeMenu(); return; }
  let menu = $("trunks-mentions");
  if (!menu) {
    menu = document.createElement("ul");
    menu.id = "trunks-mentions";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", say("trunks.mentions", "Trunks"));
    menu.style.cssText = "list-style:none;margin:4px 0;padding:4px;border:1px solid var(--line);border-radius:var(--r2);background:var(--panel);max-width:100%;overflow:hidden";
    box.closest("form")?.append(menu);
  }
  menu.replaceChildren(...found.map((trunk, index) => {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === 0));
    item.dataset.handle = trunk.handle;
    item.append(avatar(trunk, 18), plain("span", ` @${trunk.handle} — ${trunk.name}`));
    item.addEventListener("mousedown", (event) => { event.preventDefault(); choose(box, trunk.handle); });
    return item;
  }));
}
function choose(box, handle) {
  const mention = mentionAt(box);
  if (!mention) return;
  const end = box.selectionStart ?? box.value.length;
  box.value = `${box.value.slice(0, mention.start)}@${handle} ${box.value.slice(end)}`;
  box.selectionStart = box.selectionEnd = mention.start + handle.length + 2;
  closeMenu();
}
function moveChoice(step) {
  const items = [...($("trunks-mentions")?.children ?? [])];
  const at = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
  items.forEach((item, index) => item.setAttribute("aria-selected", String(index === (at + step + items.length) % items.length)));
}
function watchComposer() {
  const box = $("prompt"), form = $("chat-form");
  if (!box || !form || box.dataset.trunks) return;
  box.dataset.trunks = "on";
  box.addEventListener("input", () => { if (globalThis.branchRooms?.handlesMentions()) return; if (known.length) showMenu(box); }); // phase2/rooms
  box.addEventListener("blur", () => setTimeout(closeMenu, 100));
  box.addEventListener("keydown", (event) => {
    const menu = $("trunks-mentions");
    if (!menu || globalThis.branchRooms?.handlesMentions()) return; // phase2/rooms
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopImmediatePropagation(); moveChoice(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault(); event.stopImmediatePropagation();
      choose(box, menu.querySelector('[aria-selected="true"]')?.dataset.handle ?? "");
    } else if (event.key === "Escape") { event.stopImmediatePropagation(); closeMenu(); }
  }, true);
  form.addEventListener("submit", (event) => {
    if (globalThis.branchRooms?.handlesMentions()) return; // phase2/rooms: public/rooms.js decides where "@name" goes
    const match = /^@([a-z0-9-]+)\s+([\s\S]+)$/i.exec(box.value.trim());
    const trunk = match && known.find((entry) => entry.handle === match[1].toLowerCase());
    if (!trunk) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    box.value = "";
    void sendToTrunk(trunk, match[2].trim());
  }, true);
}
async function sendToTrunk(trunk, text) {
  try {
    await openChat(trunk);
    await api(`trunks/${trunk.id}/say`, { text });
    await openConversation(trunk.chatSessionId);
    await api(`trunks/${trunk.id}/seen`, {}).catch(() => undefined);
  } catch (error) { globalThis.toast?.(error.message ?? String(error)); }
  void drawRail();
}

/* ---------- drawing ---------- */
export async function draw() {
  try {
    const fresh = await card();
    const old = $("trunks-card");
    if (old) old.replaceWith(fresh); else document.body.append(fresh);
    const roster = await api("trunks");
    known = roster.modes.trunks === "off" ? [] : roster.trunks;
  } catch { /* the card failing leaves the rest of the window as it was */ }
  await drawRail();
  watchComposer();
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
  // The roster follows new replies without a reload.
  setInterval(() => { if (!document.hidden) void drawRail(); }, 15000);
});
