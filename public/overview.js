/* phase2/shell: the Overview (critique #11: "the Overview page is empty"), after the KeepOak
   portal's Home, and each reply's own face (critique #18: replies show the assistant's own look,
   not Branch's logo).

   The Overview is about whatever was picked in the strip: this computer (what is working, what needs
   your yes, what finished lately, its schedules, who uses it), one of your other computers (whether
   it is connected, what it may do, rename, remove) or a Trunk (its conversation, look and settings).
   Everything comes from the app's own routes; nothing is sample data. No colour is written here. */
import { api, displayView, toast } from "/app.js";
import { formatDate } from "/i18n.js";
import { assistantSpec, computerSpec, face, personSpec, trunkSpec } from "/faces.js";
import { findDevice, findTrunk, isOwner, make, openTrunk, platformWord, refresh, say, shell } from "/strip.js";

const $ = (id) => document.getElementById(id);
const when = (iso) => formatDate(iso, { dateStyle: "medium", timeStyle: "short" });
function button(className, key, english, handler, values) {
  const node = make("button", /glass-option/.test(className) ? className : `shell-btn ${className}`.trim(), key, english, values);
  node.type = "button";
  node.addEventListener("click", () => void Promise.resolve(handler()).catch((error) => toast(error.message ?? String(error))));
  return node;
}
async function studio() { return import("/studio.js"); }

/* ---------- the page frame ---------- */
function head(spec, eyebrow, title, pill, pillKind) {
  const top = make("div", "ov-head");
  const words = make("div", "grow");
  const small = make("p", "shell-eyebrow");
  small.textContent = eyebrow;
  const big = make("h2", "shell-title");
  big.textContent = title;
  const state = make("span", `shell-pill ${pillKind}`);
  state.textContent = pill;
  words.append(small, big, state);
  top.append(face(spec, 64, { flat: true }), words);
  return top;
}
function block(key, english, rows, emptyKey, emptyEnglish) {
  const part = make("section", "ov-block");
  part.append(make("h3", "", key, english));
  if (rows.length) { const list = make("div", "ov-rows"); list.append(...rows); part.append(list); }
  else part.append(make("p", "shell-note", emptyKey, emptyEnglish));
  return part;
}
function row(title, sub, ...actions) {
  const line = make("div", "ov-row");
  const words = make("div", "grow");
  const strong = make("b");
  strong.textContent = title;
  const small = make("small");
  small.textContent = sub;
  words.append(strong, small);
  line.append(words, ...actions);
  return line;
}
const task = (run) => String(run.prompt || say("ov.task", "A task")).replace(/\s+/g, " ").slice(0, 120);
function openRun(run) {
  return button("", "ov.open", "Open", async () => { displayView("chat"); const { openConversation } = await import("/app.js"); await openConversation(run.sessionId); });
}

/* ---------- this computer ---------- */
function schedulesWords(schedule) {
  const data = schedule.data ?? schedule;
  if (data.cron) return say("schedule.rhythm.cron", "Cron {cron} ({timezone})", data);
  if (data.monthDay) return say("schedule.overview.monthly", "Every month on day {day} at {time}", { day: data.monthDay, time: data.dailyAt });
  if (data.weekdays) {
    const days = data.weekdays.map((day) => say(`schedule.weekday.${day}`, ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day])).join(", ");
    return say("schedule.overview.weekdays", "Every {days} at {time}", { days, time: data.dailyAt });
  }
  if (data.dailyAt) return say("ov.daily", "Every day at {time}", { time: data.dailyAt });
  if (data.intervalMs) return say("ov.every", "Every {n} min", { n: Math.round(data.intervalMs / 60000) });
  return data.dueAt ? say("ov.once", "Once, {when}", { when: when(data.dueAt) }) : "";
}
async function hereBody(page) {
  const state = await api("state").catch(() => ({ runs: [], schedules: [] }));
  const trunkChats = new Set((shell.roster?.trunks ?? []).map((trunk) => trunk.chatSessionId));
  const runs = [...(state.runs ?? [])].filter((run) => !trunkChats.has(run.sessionId)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const working = runs.filter((run) => run.status === "running"), waiting = runs.filter((run) => /waiting|approval/.test(run.status));
  const finished = runs.filter((run) => run.status === "completed").slice(0, 5);
  const busy = waiting.length ? ["ov.needsYou", "Needs you", "warn"] : working.length ? ["ov.working", "Working", "ok"] : ["ov.calm", "Nothing waiting", "ok"];
  page.append(head(computerSpec({ id: "here", name: "here", here: true }), say("ov.here.eyebrow", "The computer you are on"), say("strip.here", "This computer"), say(busy[0], busy[1]), busy[2]));
  const acts = make("div", "ov-acts");
  acts.append(button("studio-primary", "rail.new", "New conversation", () => { displayView("chat"); $("new-session")?.click(); }));
  if (isOwner()) acts.append(button("", "strip.add", "Add a Trunk or pair a computer", async () => (await studio()).openAdd("trunk")));
  page.append(acts);
  const grid = make("div", "ov-grid");
  grid.append(block("ov.now", "Working on now", working.map((run) => row(task(run), say("ov.since", "Since {when}", { when: when(run.createdAt) }), openRun(run))), "ov.now.none", "Nothing is running right now."),
    block("ov.needs", "Needs you", waiting.map((run) => row(task(run), say("ov.waiting", "Waiting for your yes"), openRun(run))), "ov.needs.none", "Nothing needs you."),
    block("ov.finished", "Finished lately", finished.map((run) => row(task(run), when(run.updatedAt || run.createdAt), openRun(run))), "ov.finished.none", "Nothing finished yet."),
    block("ov.schedules", "Schedules", (state.schedules ?? []).slice(0, 6).map((schedule) => row(task(schedule.data ?? schedule), schedulesWords(schedule))), "ov.schedules.none", "No schedules."),
    whoBlock(), ...(isOwner() ? [lentBlock()] : []));
  page.append(grid);
}
function whoBlock() {
  const people = [{ name: say("household.owner", "The owner"), role: say("household.role.owner", "Owner") },
    ...(shell.profiles?.profiles ?? []).map((person) => ({ name: person.name, role: say(...roleWord(person.id)) }))];
  const part = block("ov.who", "Who uses it", people.map((person) => {
    const line = row(person.name, person.role);
    line.prepend(face(personSpec({ name: person.name }), 30, { flat: true }));
    return line;
  }), "household.never", "Has not used Branch yet");
  part.append(button("", "household.open", "People…", async () => (await import("/people-place.js")).showPeople()));
  return part;
}
function roleWord(id) {
  const role = shell.profiles?.roles?.find((entry) => entry.profileId === id)?.grant.role ?? "adult";
  return [`household.role.${role}`, { owner: "Owner", adult: "Adult", child: "Child" }[role]];
}
function lentBlock() {
  const join = shell.join;
  const lent = join && (join.state === "joined" || join.state === "waiting");
  return block("ov.lent", "Lent to another Branch", lent ? [row(join.hub ?? "", join.connected ? say("ov.lent.on", "Connected. The owner there decides what Branch may do on this computer; everything starts off.") : say("ov.lent.off", "Not connected right now"),
    button("", "pair.join.leave", "Leave", async () => { await api("devices/join/leave", {}); await refresh(); await drawOverview(); }))] : [],
  "ov.lent.none", "Not lent to another computer. Add a Trunk › Another computer › Join another computer lends it.");
}

/* ---------- one of your other computers ---------- */
const CAP_WORDS = { camera: "Take a photo with the camera", screen: "Take a picture of the screen", location: "Say where the device is", notify: "Show a notification",
  "clipboard-read": "Read what was copied", "clipboard-write": "Put text on the clipboard", "open-url": "Open a web page", run: "Run a command inside a walled folder",
  files: "Read and list files in one chosen folder", speak: "Say something out loud", listen: "Listen for a few seconds", canvas: "Show a page on the screen" };
const capKey = (id) => `devices.cap.${id.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`;
function deviceBody(page, device) {
  const seen = device.connected ? say("devices.device.connected", "Connected now") : device.lastSeen ? say("ov.device.seen", "Last seen {when}", { when: when(device.lastSeen) }) : say("devices.device.never", "Not connected yet");
  page.append(head(computerSpec(device), platformWord(device.platform), device.name, seen, device.connected ? "ok" : "idle"));
  const acts = make("div", "ov-acts");
  acts.append(button("", "strip.menu.rename", "Rename…", async () => (await studio()).renameDevice(device)),
    button("", "ov.device.switches", "Switch what it may do", () => displayView("customize:channels")),
    button("studio-danger", "strip.menu.removeDevice", "Remove this computer…", async () => (await studio()).confirmRemoveDevice(device)));
  page.append(acts);
  const grid = make("div", "ov-grid");
  const enabled = (device.enabled ?? []).map((cap) => row(say(capKey(cap), CAP_WORDS[cap] ?? cap), say("ov.device.on", "Switched on")));
  grid.append(block("ov.device.may", "What Branch may do on it", enabled, "ov.device.nothing", "Nothing is switched on, so Branch uses nothing on it."),
    block("ov.device.about", "About it", [row(say("ov.device.paired", "Paired"), when(device.pairedAt)), ...(device.folder ? [row(say("devices.device.folder", "The one folder it may read and run commands in"), device.folder)] : [])], "", ""));
  page.append(grid);
}

/* ---------- a Trunk ---------- */
function trunkBody(page, trunk) {
  page.append(head(trunkSpec(trunk), say("ov.trunk.eyebrow", "A Trunk"), trunk.name, trunk.working ? say("ov.working", "Working") : say("strip.status.on", "Ready"), "ok"));
  if (trunk.title) { const lede = make("p", "shell-lede"); lede.textContent = trunk.title; page.append(lede); }
  const acts = make("div", "ov-acts");
  acts.append(button("studio-primary", "ov.trunk.talk", "Open its conversation", () => openTrunk(trunk)),
    button("", "strip.menu.look", "Change look…", async () => (await studio()).openEdit(trunk.id)));
  page.append(acts);
  const reach = [trunk.reach?.commands ? say("ov.trunk.commands", "May run commands on this computer") : say("ov.trunk.noCommands", "May not run commands on this computer"),
    trunk.reach?.channels?.length ? say("ov.trunk.chats", "Answers on {list}", { list: trunk.reach.channels.join(", ") }) : say("ov.trunk.noChats", "Answers on no chat app")];
  const grid = make("div", "ov-grid");
  grid.append(block("ov.trunk.latest", "Its latest words", trunk.latest ? [row(trunk.latest.text.slice(0, 160), when(trunk.at))] : [], "ov.trunk.quiet", "Nothing said yet."),
    block("ov.trunk.reach", "What it may reach", reach.map((line) => row(line, "")), "", ""));
  page.append(grid);
}

/* ---------- drawing ---------- */
export async function drawOverview() {
  const slot = $("lx-slot-overview-here");
  if (!slot) return;
  const page = make("div", "shell-page ov-page");
  const [kind, id] = shell.target.split(":");
  const device = kind === "device" ? findDevice(id) : null, trunk = kind === "trunk" ? findTrunk(id) : null;
  if (device) deviceBody(page, device);
  else if (trunk) trunkBody(page, trunk);
  else await hereBody(page);
  slot.replaceChildren(page);
}
document.addEventListener("branch-overview", () => void drawOverview());
document.addEventListener("branch-place", (event) => { if (event.detail?.place === "overview") void drawOverview(); });

/* ---------- each reply's own face ----------
   The assistant on this computer (named in Settings › Assistant) or the specialist who answered, drawn
   from its name. A Trunk's reply is given its face by public/rooms.js (data-trunk), so it is left alone. */
function trunkOfConversation() {
  const session = $("conversation")?.dataset.sessionId;
  return session ? shell.roster?.trunks?.find((trunk) => trunk.chatSessionId === session) ?? null : null;
}
function signReplies() {
  const trunk = trunkOfConversation();
  // With rooms (public/rooms.js) in the window, a Trunk's replies get their face there.
  if (trunk && globalThis.branchRooms) return;
  for (const reply of document.querySelectorAll("#conversation > .message.assistant:not(.tool-step):not([data-trunk])")) {
    const by = reply.querySelector(":scope > small");
    if (!by || reply.querySelector(":scope > .message-face")) continue;
    const mark = face(trunk ? trunkSpec(trunk) : assistantSpec(by.textContent || "Branch"), 22, { flat: true });
    mark.classList.add("message-face");
    if (trunk) reply.dataset.trunk = trunk.id;
    else mark.dataset.assistant = "";
    by.before(mark);
  }
}
function watchReplies() {
  const thread = $("conversation");
  if (!thread) return;
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; signReplies(); }); })
    .observe(thread, { childList: true });
  signReplies();
}
watchReplies();
