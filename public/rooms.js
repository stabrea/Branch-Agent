/* Redesign phase 2 "rooms" (critique #32): who answers in a conversation, rooms as conversations,
   and @mentions. The faces at the top of a conversation say who answers there; pressing them lists
   who is in, lets you bring a Trunk in or take one out, and @ one. A room (two to six Trunks and you,
   src/trunks/rooms.ts) opens here as a conversation: each reply signed with its Trunk's face and
   name, a Trunk waiting for your yes answered in place, and Stop while it talks.

   Everything here only asks and shows; the server decides (src/trunks/conversations.ts). Nothing
   shows unless Trunks are on, and choosing a Trunk for a conversation has its own switch
   (Customize › Specialists › Trunks, "Choosing a Trunk to answer in any conversation"), off at first.
   Colours only through tokens (public/rooms.css). */
import { api, displayView, openConversation, toast } from "/app.js";
import { formatDate, t } from "/i18n.js";
import { fillMarkdown } from "/markdown.js";
import { trackPopover } from "/popover.js";
import { avatar } from "/trunks.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (w, n) => (values && n in values ? String(values[n]) : w)) : word;
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function press(className, text, handler, label) {
  const node = el("button", className, text);
  node.type = "button";
  if (label) { node.setAttribute("aria-label", label); node.title = label; }
  node.addEventListener("click", (event) => { event.stopPropagation(); void handler(event); });
  return node;
}
const MAX_MEMBERS = 6;
const TRUNK_KINDS = ["trunk", "trunk-chat", "member"];

/* ---------- what is known ---------- */
let roster = null; // GET /api/trunks: { modes, trunks, rooms }, or null when this is not the owner's to see
let info = null;   // GET /api/trunks/conversations/:id for the conversation on screen
let roomView = null;
let pollTimer = null;
let bypass = false;

const session = () => $("conversation")?.dataset.sessionId || null;
const on = (part) => Boolean(roster && roster.modes?.trunks !== "off" && roster.modes?.[part] !== "off");
const trunksOn = () => Boolean(roster && roster.modes?.trunks !== "off");
const kind = () => info?.kind ?? "plain";
const inRoom = () => kind() === "room" && Boolean(info?.room);
const everyTrunk = () => (roster?.trunks ?? []).filter((trunk) => !trunk.hidden);
const byId = (id) => everyTrunk().find((trunk) => trunk.id === id) ?? info?.room?.members.find((m) => m.id === id) ?? (info?.trunk?.id === id ? info.trunk : null);
const handleOf = (id) => byId(id)?.handle ?? "?";
/** Who answers here now, as Trunks (none: your assistant). */
function present() {
  if (inRoom()) return info.room.members;
  return info?.trunk && TRUNK_KINDS.includes(kind()) ? [info.trunk] : [];
}
const ready = () => $("workspace")?.hidden === false && Boolean(sessionStorage.getItem("branch-token"));

/** Everything that decides what is drawn, read again. */
async function refresh() {
  if (!ready()) return;
  try { roster = await api("trunks"); } catch { roster = null; }
  const here = session();
  info = trunksOn() && here ? await api(`trunks/conversations/${here}`).catch(() => null) : null;
  paintWho();
  paintHero();
  if (inRoom()) await drawRoom();
  else { leaveRoom(); signReplies(); }
  document.dispatchEvent(new CustomEvent("branch-rooms-changed", { detail: {
    kind: kind(), trunkId: kind() === "trunk" ? info?.trunk?.id ?? null : null,
  } }));
}

/* ---------- faces ---------- */
function face(trunk, size) {
  const holder = el("span", "rooms-face");
  holder.dataset.trunk = trunk.id;
  // Integration review: avatar() now sets its colours in a way the window's content rules allow (public/trunks.js).
  try { holder.append(avatar(trunk, size)); } catch { holder.textContent = (trunk.name || "?").slice(0, 1); }
  return holder;
}
function assistantGlyph() {
  const holder = el("span", "rooms-face rooms-face-assistant");
  holder.setAttribute("aria-hidden", "true");
  holder.textContent = "✦";
  return holder;
}
function faceStack(people) {
  const stack = el("span", "rooms-stack");
  if (!people.length) stack.append(assistantGlyph());
  for (const trunk of people.slice(0, 3)) stack.append(face(trunk, 22));
  if (people.length > 3) stack.append(el("em", "rooms-more", `+${people.length - 3}`));
  return stack;
}
function whoWords() {
  const people = present();
  if (!people.length) return say("rooms.who.assistant", "Your assistant answers here. Choose who answers");
  return say("rooms.who.people", "In this conversation: {names}", { names: people.map((p) => p.name).join(", ") });
}

/* ---------- the faces button at the top, and "Talking to" on an empty conversation ---------- */
/** Whether the faces are offered at all: never for a household person, never with Trunks off. */
function offered() {
  if (!trunksOn()) return false;
  return on("conversations") || kind() !== "plain" || (info?.authors?.length ?? 0) > 1;
}
function whoButton() {
  let button = $("who-button");
  if (button) return button;
  button = el("button", "rooms-who");
  button.id = "who-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (event) => { event.stopPropagation(); togglePop(button); });
  document.querySelector("main > header .head-title")?.after(button);
  return button;
}
function paintWho() {
  const button = whoButton();
  const show = offered() && $("thread-name")?.hidden !== true;
  button.hidden = !show;
  if (!show) { closePop(); return; }
  button.replaceChildren(faceStack(present()));
  if (!present().length) button.append(el("span", "rooms-who-words", say("rooms.who.choose", "Who answers")));
  button.setAttribute("aria-label", whoWords());
  button.title = whoWords();
}
function paintHero() {
  let chip = $("who-hero");
  const empty = !session() || ($("conversation")?.children.length ?? 0) === 0;
  const show = on("conversations") && empty && !inRoom();
  if (!show) { if (chip) chip.hidden = true; return; }
  if (!chip) {
    chip = el("button", "rooms-hero");
    chip.id = "who-hero";
    chip.type = "button";
    chip.setAttribute("aria-haspopup", "dialog");
    chip.setAttribute("aria-expanded", "false");
    chip.addEventListener("click", (event) => { event.stopPropagation(); togglePop(chip); });
    $("greeting")?.after(chip);
  }
  chip.hidden = false;
  const people = present();
  chip.replaceChildren(el("span", "rooms-hero-lead", say("rooms.talkingTo", "Talking to")), faceStack(people),
    el("b", "", people.length ? people.map((p) => p.name).join(", ") : say("rooms.yourAssistant", "your assistant")), el("span", "rooms-chevron", "⌄"));
  chip.setAttribute("aria-label", whoWords());
}

/* ---------- the list of who is in ---------- */
let pop = null;
function panel() {
  let node = $("who-pop");
  if (node) return node;
  node = el("div", "rooms-pop");
  node.id = "who-pop";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", say("rooms.here", "In this conversation"));
  node.hidden = true;
  node.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(node);
  return node;
}
function closePop() { pop?.close(); }
function togglePop(trigger) {
  if (pop && pop.trigger === trigger) { closePop(); return; }
  const node = panel();
  paintPop(node);
  node.hidden = false;
  place(node, trigger);
  trigger.setAttribute("aria-expanded", "true");
  pop = trackPopover(trigger, node, () => { node.hidden = true; trigger.setAttribute("aria-expanded", "false"); pop = null; });
  (node.querySelector("input, .rooms-row button, .rooms-add") ?? node).focus?.();
}
/** Under the button when there is room, above it otherwise; never off the side of the window. */
function place(node, trigger) {
  const at = trigger.getBoundingClientRect(), width = Math.min(340, innerWidth - 24);
  node.style.width = `${width}px`;
  node.style.left = `${Math.max(12, Math.min(at.left, innerWidth - width - 12))}px`;
  const below = innerHeight - at.bottom - 16, above = at.top - 16;
  const roomy = below >= Math.min(node.scrollHeight, 360) || below >= above;
  node.style.maxHeight = `${Math.max(160, roomy ? below : above)}px`;
  node.style.top = roomy ? `${at.bottom + 8}px` : "";
  node.style.bottom = roomy ? "" : `${innerHeight - at.top + 8}px`;
}
function paintPop(node) {
  const k = kind();
  const parts = [el("p", "rooms-heading", say("rooms.here", "In this conversation")), ...memberRows(k)];
  if (k === "member") parts.push(memberNote());
  else parts.push(...addSection(k));
  if (inRoom()) parts.push(el("p", "rooms-note", say("trunks.rooms.purpose", "Two to six Trunks and you in one conversation. Only those you @mention answer; nobody mentioned means everyone.")));
  node.replaceChildren(...parts);
}
function memberRow(trunk, small, actions) {
  const row = el("div", "rooms-row");
  const words = el("span", "rooms-row-words");
  words.append(el("b", "", trunk.name), el("small", "", small));
  row.append(face(trunk, 28), words, ...actions);
  return row;
}
function memberRows(k) {
  if (k === "plain") {
    const row = el("div", "rooms-row");
    const words = el("span", "rooms-row-words");
    words.append(el("b", "", say("rooms.yourAssistantName", "Your assistant")), el("small", "", say("rooms.answersHere", "Answers here now")));
    row.append(assistantGlyph(), words);
    return [row];
  }
  const people = present();
  return people.map((trunk) => {
    const actions = [press("rooms-icon", "@", () => mention(trunk), say("rooms.mention", "Mention @{handle}", { handle: trunk.handle }))];
    if (k === "trunk") actions.push(press("rooms-icon", "✕", () => choose(null), say("rooms.backToAssistant", "Let your assistant answer here again")));
    if (k === "room" && people.length > 2) actions.push(press("rooms-icon", "✕", () => takeOut(trunk), say("rooms.takeOut", "Take {name} out of this room", { name: trunk.name })));
    const small = k === "trunk-chat" ? say("rooms.ownChat", "Its own conversation") : trunk.title || "";
    return memberRow(trunk, small, actions);
  });
}
/** One Trunk's side of a room: talking happens in the room itself. */
function memberNote() {
  const box = el("div", "rooms-section");
  box.append(el("p", "rooms-note", say("rooms.memberNote", "This is one Trunk's side of a room. Talk to it in the room.")));
  if (info?.memberOf) box.append(press("rooms-add", say("rooms.openRoom", "Open the room"), () => openRoom(info.memberOf)));
  return box;
}

/* ---------- bringing a Trunk in ---------- */
/** What adding means here, or why it cannot be done right now (said, never hidden). */
function addPlan(k) {
  if (k === "plain") return on("conversations") ? { heading: say("rooms.add.choose", "Choose who answers here") }
    : { refusal: say("rooms.add.offConversations", "Choosing a Trunk for a conversation is switched off. Switch it on in Customize › Specialists › Trunks.") };
  if (k === "room") return present().length >= MAX_MEMBERS ? { refusal: say("rooms.add.full", "A room holds two to six Trunks and you.") }
    : { heading: say("rooms.add.room", "Add a Trunk") };
  if (!on("rooms") || !on("conversations"))
    return { refusal: say("rooms.add.offRooms", "To bring several Trunks in, switch on Rooms and Choosing a Trunk in Customize › Specialists › Trunks.") };
  return { heading: say("rooms.add.another", "Bring another Trunk in"), note: say("rooms.add.anotherNote", "This makes a room with both of them. This conversation stays as it is.") };
}
function addSection(k) {
  const plan = addPlan(k);
  if (plan.refusal) return [el("p", "rooms-note", plan.refusal)];
  const here = new Set(present().map((p) => p.id));
  const choices = everyTrunk().filter((trunk) => !here.has(trunk.id));
  const list = el("div", "rooms-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", plan.heading);
  for (const trunk of choices) {
    const row = press("rooms-add", "", () => bringIn(trunk));
    row.dataset.name = `${trunk.name} ${trunk.handle}`.toLowerCase();
    const words = el("span", "rooms-row-words");
    words.append(el("b", "", trunk.name), el("small", "", trunk.title || `@${trunk.handle}`));
    row.append(face(trunk, 24), words);
    list.append(row);
  }
  const parts = [el("p", "rooms-heading", plan.heading)];
  if (choices.length > 5) parts.push(searchBox(list));
  parts.push(choices.length ? list : el("p", "rooms-note", say("rooms.add.none", "Every Trunk you have is already here.")));
  if (plan.note && choices.length) parts.push(el("p", "rooms-note", plan.note));
  return parts;
}
function searchBox(list) {
  const box = el("input", "rooms-search");
  box.type = "search";
  box.placeholder = say("rooms.search", "Search Trunks");
  box.setAttribute("aria-label", box.placeholder);
  box.addEventListener("input", () => {
    const wanted = box.value.trim().toLowerCase();
    for (const row of list.children) row.hidden = !row.dataset.name.includes(wanted);
  });
  return box;
}

/* ---------- doing it ---------- */
async function attempt(work) {
  try { await work(); } catch (error) { toast(error.message ?? String(error)); }
}
function bringIn(trunk) {
  closePop();
  return attempt(async () => {
    const k = kind(), here = session();
    if (!here) return startWith(trunk);
    if (k === "plain") return setChoice(trunk.id);
    if (k === "room") {
      await api(`trunks/rooms/${info.room.id}`, { members: [...present().map((p) => p.id), trunk.id] });
      toast(say("rooms.joined", "{name} is in this room now.", { name: trunk.name }));
      return refresh();
    }
    const made = await api(`trunks/conversations/${here}/room`, { trunkId: trunk.id });
    await openConversation(made.room.sessionId);
    toast(say("rooms.madeRoom", "{names} are in a room together. Your conversation with {first} stays as it was.",
      { names: made.room.name, first: info?.trunk?.name ?? "" }));
  });
}
/** A new conversation that a Trunk answers in, begun in the mode the chip shows. */
async function startWith(trunk) {
  const mode = globalThis.branchConversationMode?.pending() ?? null;
  const { sessionId } = await api("trunks/conversations", { trunkId: trunk.id });
  if (mode) await api("conversation-mode", { sessionId, mode }).catch(() => undefined);
  await openConversation(sessionId);
  toast(say("rooms.talking", "Talking to {name}.", { name: trunk.name }));
}
/** Who answers in the conversation on screen from now on (null: your assistant). Throws when refused. */
async function setChoice(trunkId) {
  info = await api(`trunks/conversations/${session()}`, { trunkId });
  const name = trunkId ? byId(trunkId)?.name : null;
  toast(name ? say("rooms.answersNow", "{name} answers here from now on.", { name }) : say("rooms.assistantNow", "Your assistant answers here again."));
  await refresh();
}
async function choose(trunkId) {
  closePop();
  await attempt(() => setChoice(trunkId));
}
async function takeOut(trunk) {
  closePop();
  await attempt(async () => {
    await api(`trunks/rooms/${info.room.id}`, { members: present().map((p) => p.id).filter((id) => id !== trunk.id) });
    toast(say("rooms.left", "{name} left this room.", { name: trunk.name }));
    await refresh();
  });
}
/** Puts "@name " in the message box where the cursor is. */
function mention(trunk) {
  closePop();
  const box = $("prompt");
  if (!box) return;
  const at = box.selectionStart ?? box.value.length;
  const before = box.value.slice(0, at).replace(/@[\w-]*$/, "");
  const gap = before && !/\s$/.test(before) ? " " : "";
  box.value = `${before}${gap}@${trunk.handle} ${box.value.slice(at)}`;
  const caret = before.length + gap.length + trunk.handle.length + 2;
  box.focus();
  box.setSelectionRange(caret, caret);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  closePicker();
}
/** Opens a room as a conversation. Returns false when it cannot be found, so an older caller can carry on. */
function openRoom(roomId) {
  const room = (roster?.rooms ?? []).find((r) => r.id === roomId);
  if (!room?.sessionId) return false;
  closePop();
  displayView("chat");
  void openConversation(room.sessionId).catch((error) => toast(error.message));
  return true;
}

/* ---------- a room, drawn as the conversation ---------- */
/** "@name" in what somebody wrote becomes a small chip with the Trunk's face; the words stay the words. */
function withMentions(text) {
  const out = el("span", "rooms-text");
  let last = 0;
  for (const match of String(text).matchAll(/@([A-Za-z0-9][\w.-]*)/g)) {
    const trunk = everyTrunk().find((t) => t.handle === match[1].toLowerCase()) ?? present().find((t) => t.handle === match[1].toLowerCase());
    const everyone = ["all", "everyone"].includes(match[1].toLowerCase());
    if (!trunk && !everyone) continue;
    out.append(document.createTextNode(text.slice(last, match.index)));
    const chip = el("span", "rooms-chip");
    if (trunk) chip.append(face(trunk, 14));
    chip.append(document.createTextNode(match[0]));
    out.append(chip);
    last = match.index + match[0].length;
  }
  out.append(document.createTextNode(text.slice(last)));
  return out;
}
function signed(node, trunk) {
  node.dataset.trunk = trunk.id;
  node.querySelector(".message-face[data-assistant]")?.remove();
  const by = el("small", "rooms-by");
  const holder = face(trunk, 20);
  holder.classList.add("message-face");
  by.append(holder, el("span", "", trunk.name));
  return by;
}
function replyNode(event) {
  const trunk = byId(event.memberId) ?? { id: event.memberId, name: say("rooms.gone", "A Trunk that has gone"), handle: "?" };
  const node = el("div", "message assistant rooms-reply");
  node.append(signed(node, trunk));
  const handedBy = handedOver(event);
  if (handedBy) node.append(el("p", "rooms-handoff", say("rooms.handedOver", "{from} brought {to} in", { from: handedBy.name, to: trunk.name })));
  node.append(fillMarkdown(el("div", "message-body"), event.text));
  const controls = el("div", "message-controls");
  controls.append(press("text-button", say("trunks.room.reply", "Reply to @{handle}", { handle: trunk.handle }), () => mention(trunk)));
  node.append(controls);
  return node;
}
/** In a later round, the Trunk whose words called this one in. */
function handedOver(event) {
  if (!event.round) return null;
  const handle = `@${handleOf(event.memberId)}`.toLowerCase();
  const earlier = roomView.events.filter((e) => e.kind === "member" && e.discussion === event.discussion && e.seq < event.seq && e.memberId !== event.memberId);
  const caller = [...earlier].reverse().find((e) => e.text.toLowerCase().includes(handle));
  return caller ? byId(caller.memberId) : null;
}
function eventNode(event) {
  const name = byId(event.memberId)?.name ?? "";
  if (event.kind === "user") {
    const node = el("div", "message user");
    node.dataset.rewind = "room"; // going back to a message is for an ordinary conversation (public/rewind.js)
    node.append(el("small", "", event.personName ?? say("rooms.you", "You")), withMentions(event.text));
    return node;
  }
  if (event.kind === "member") return replyNode(event);
  const words = {
    pass: say("rooms.passed", "{name} had nothing to add.", { name }),
    failed: say("rooms.failed", "{name} could not answer: {why}", { name, why: event.text.slice(0, 200) }),
    waiting: event.answered ? say("rooms.asked", "{name} asked you, and you answered.", { name }) : say("rooms.waiting", "{name} is waiting for your answer.", { name }),
    stopped: say("rooms.stopped", "You stopped the room."),
  }[event.kind];
  return words ? el("p", `rooms-line${event.kind === "failed" ? " warn" : ""}`, words) : null;
}
async function drawRoom() {
  const here = session(), id = info.room.id;
  roomView = await api(`trunks/rooms/${id}`).catch(() => null);
  if (!roomView || session() !== here || !inRoom()) return;
  const box = $("conversation");
  box.dataset.room = roomView.id;
  const nodes = roomView.events.map(eventNode).filter(Boolean);
  if (!nodes.length) nodes.push(el("p", "rooms-line", say("rooms.empty", "Say something to the room. Only those you @mention answer; nobody mentioned means everyone.")));
  const grown = box.dataset.roomSeen !== `${roomView.id}:${roomView.seq}:${roomView.waiting?.length ?? 0}:${roomView.speaking}`;
  box.replaceChildren(...nodes, ...artifactCard(roomView), ...allowedCard(roomView), ...asks(roomView), ...talking(roomView));
  box.dataset.roomSeen = `${roomView.id}:${roomView.seq}:${roomView.waiting?.length ?? 0}:${roomView.speaking}`;
  // Only something new brings the newest line into view, so reading back up is never interrupted.
  if (grown) ($("chat") ?? box).scrollIntoView({ block: "end" }); // its end keeps room for the message box
  if ($("thread-name")) $("thread-name").textContent = roomView.name;
  const prompt = $("prompt");
  if (prompt && !prompt.dataset.roomsPlaceholder) {
    prompt.dataset.roomsPlaceholder = prompt.placeholder;
    prompt.placeholder = say("rooms.placeholder", "Message the room. Type @ to ask someone");
  }
  paintHero();
  schedule(roomView.speaking);
}
function leaveRoom() {
  clearTimeout(pollTimer);
  pollTimer = null;
  roomView = null;
  delete $("conversation")?.dataset.room;
  const prompt = $("prompt");
  if (prompt?.dataset.roomsPlaceholder !== undefined) {
    prompt.placeholder = prompt.dataset.roomsPlaceholder;
    delete prompt.dataset.roomsPlaceholder;
  }
}
/** While the room is talking it is read again every second or so; it stops when the room is quiet. */
function schedule(speaking, soon = false) {
  clearTimeout(pollTimer);
  if (!speaking && !soon) return;
  const here = session();
  pollTimer = setTimeout(() => { if (session() === here && inRoom() && !document.hidden) void drawRoom(); }, 1200);
}
function talking(view) {
  if (!view.speaking) return [];
  const row = el("div", "rooms-talking");
  row.setAttribute("role", "status");
  row.append(el("span", "rooms-dots"), el("span", "", say("rooms.talkingNow", "The room is talking…")));
  if (view.owner) row.append(press("rooms-stop", say("rooms.stop", "Stop"),
    () => attempt(async () => { await api(`trunks/rooms/${view.id}/stop`, {}); await drawRoom(); }),
    say("rooms.stopLabel", "Stop the room: nobody else is asked")));
  return [row];
}

function artifactCard(view) {
  const card = el("section", "rooms-artifacts");
  card.append(el("h3", "", say("rooms.artifacts", "Shared with this room")));
  if (view.people?.length) card.append(el("p", "rooms-people", say("rooms.peopleHere", "People here: {names}", {
    names: view.people.map((person) => person.name).join(", "),
  })));
  for (const artifact of view.artifacts ?? []) {
    const item = el("article", "rooms-artifact");
    item.append(el("b", "", artifact.name), el("small", "", say("rooms.artifactBy", "Shared by {name}", { name: artifact.personName })),
      el("pre", "", artifact.content));
    card.append(item);
  }
  const name = el("input", "rooms-artifact-name"), content = el("textarea", "rooms-artifact-content");
  name.placeholder = say("rooms.artifactName", "Name");
  content.placeholder = say("rooms.artifactContent", "Text to share only with this room");
  card.append(name, content, press("rooms-add-artifact", say("rooms.artifactAdd", "Share"), () => attempt(async () => {
    await api(`trunks/rooms/${view.id}/artifacts`, { name: name.value.trim(), content: content.value });
    await drawRoom();
  })));
  return [card];
}

/* ---------- a Trunk waiting for your yes ---------- */
async function answer(view, ask, decision) {
  await attempt(async () => {
    await api(`trunks/rooms/${view.id}/answer`, { memberId: ask.memberId, decision, ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) });
    await drawRoom();
    schedule(false, true);
  });
}
function askRow(view, ask) {
  const trunk = byId(ask.memberId) ?? { id: ask.memberId, name: "?", handle: "?" };
  const row = el("div", "rooms-ask-row");
  const words = el("span", "rooms-row-words");
  words.append(el("b", "", trunk.name), el("small", "", ask.label || ask.tool));
  row.append(face(trunk, 24), words,
    press("rooms-yes", say("rooms.yes", "Yes"), () => answer(view, ask, "allow"), say("rooms.yesLabel", "Yes: {name} may do this in this room, for up to an hour", { name: trunk.name })),
    press("rooms-no", say("rooms.no", "No"), () => answer(view, ask, "deny"), say("rooms.noLabel", "No, {name} may not", { name: trunk.name })));
  return row;
}
/** One card for everything the room is waiting on; with several, one Yes answers them all. */
function asks(view) {
  if (!view.waiting?.length) return [];
  const names = [...new Set(view.waiting.map((ask) => byId(ask.memberId)?.name ?? "?"))];
  const card = el("div", "rooms-ask");
  card.setAttribute("role", "group");
  const title = names.length > 1 ? say("rooms.needYouMany", "{names} need you", { names: names.join(" and ") }) : say("rooms.needsYou", "{name} needs you", { name: names[0] });
  card.setAttribute("aria-label", title);
  card.append(el("p", "rooms-ask-title", title), ...view.waiting.map((ask) => askRow(view, ask)));
  if (view.waiting.length > 1)
    card.append(press("rooms-yes rooms-yes-all", say("rooms.yesAll", "Yes to all"), async () => {
      for (const ask of view.waiting) await answer(view, ask, "allow");
    }));
  return [card];
}

/* ---------- what a member may do in this room (integration review) ---------- */
/** Each yes a Trunk holds here, said plainly, with Revoke: that Trunk, that thing, this room only. */
function allowedCard(view) {
  if (!view.allowed?.length) return [];
  const card = el("div", "rooms-allowed");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", say("rooms.allowedTitle", "Allowed in this room"));
  for (const grant of view.allowed) {
    const trunk = byId(grant.memberId) ?? { id: grant.memberId, name: "?", handle: "?" };
    const words = el("span", "rooms-row-words");
    words.append(el("b", "", say("rooms.allowed", "{name} may do this in this room: {what}", { name: trunk.name, what: grant.label || grant.tool })),
      el("small", "", say("rooms.allowedUntil", "Until {time}, or until {name} leaves the room.",
        { name: trunk.name, time: formatDate(grant.expiresAt, { timeStyle: "short" }) })));
    const row = el("div", "rooms-allowed-row");
    row.append(face(trunk, 20), words, press("rooms-revoke", say("rooms.revoke", "Revoke"), () => revoke(view, grant, trunk),
      say("rooms.revokeLabel", "Take this back: {name} will ask again next time", { name: trunk.name })));
    card.append(row);
  }
  return [card];
}
async function revoke(view, grant, trunk) {
  await attempt(async () => {
    await api(`trunks/rooms/${view.id}/revoke`, { memberId: grant.memberId, tool: grant.tool, target: grant.target });
    toast(say("rooms.revoked", "{name} will ask again next time.", { name: trunk.name }));
    await drawRoom();
  });
}

/* ---------- the message box ---------- */
/** The Trunks a message names, in the order it names them (never @you, @all or an unknown name). */
function named(text) {
  const found = [];
  for (const match of text.matchAll(/(?:^|\s)@([a-z0-9][\w-]*)/gi)) {
    const trunk = everyTrunk().find((t) => t.handle === match[1].toLowerCase());
    if (trunk && !found.includes(trunk)) found.push(trunk);
  }
  return found;
}
/** What sending this message means here, or null when the window's own send does it. */
function routeFor(text) {
  if (inRoom()) return () => sendToRoom(text);
  if (!on("conversations")) return null;
  const k = kind(), names = named(text);
  if (!names.length || k === "member") return null;
  if (k === "plain") return () => chooseAndSend(names, text);
  const others = names.filter((trunk) => trunk.id !== info?.trunk?.id);
  if (!others.length || !on("rooms")) return null;
  return () => roomAndSend(others, text);
}
function clearBox() {
  const box = $("prompt");
  box.value = "";
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
async function sendToRoom(text) {
  await attempt(async () => {
    const members = present().map((p) => p.id), extra = named(text).filter((trunk) => !members.includes(trunk.id));
    if (members.length + extra.length > MAX_MEMBERS) throw new Error(say("rooms.add.full", "A room holds two to six Trunks and you."));
    if (extra.length) await api(`trunks/rooms/${info.room.id}`, { members: [...members, ...extra.map((trunk) => trunk.id)] });
    await api(`trunks/rooms/${info.room.id}/send`, { text });
    clearBox();
    await refresh();
    schedule(false, true);
  });
}
/** "@scout …" in a conversation your assistant answers: Scout answers here from now on, then the message goes. */
async function chooseAndSend(names, text) {
  await attempt(async () => {
    if (!session()) await startWith(names[0]);
    else await setChoice(names[0].id);
    if (names.length > 1 && on("rooms")) return roomAndSend(names.slice(1), text);
    resend();
  });
}
/** "@ledger …" in Scout's conversation: a room with both (and anyone else named), then the message goes there. */
async function roomAndSend(others, text) {
  await attempt(async () => {
    const made = (await api(`trunks/conversations/${session()}/room`, { trunkId: others[0].id })).room;
    if (others.length > 1) await api(`trunks/rooms/${made.id}`, { members: [...made.members, ...others.slice(1, MAX_MEMBERS - 1).map((trunk) => trunk.id)] });
    await openConversation(made.sessionId);
    await refresh();
    await sendToRoom(text);
  });
}
/** Sends what is in the box the window's own way, without coming back here. */
function resend() {
  bypass = true;
  try { $("chat-form").requestSubmit(); } finally { bypass = false; }
}
document.addEventListener("submit", (event) => {
  if (event.target?.id !== "chat-form" || bypass) return;
  const text = $("prompt")?.value.trim();
  const route = text ? routeFor(text) : null;
  if (!route) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closePicker();
  void route();
}, true);

/* ---------- "@" in the message box ---------- */
/** True when this file answers "@" in the box; public/trunks.js then leaves it alone. */
const handlesMentions = () => inRoom() || on("conversations");
function mentionAt(box) {
  const before = box.value.slice(0, box.selectionStart ?? box.value.length);
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
  return match ? match[2].toLowerCase() : null;
}
function closePicker() { $("rooms-mentions")?.remove(); }
function pickerOptions(word) {
  const here = new Set(present().map((p) => p.id));
  const found = everyTrunk().filter((trunk) => trunk.handle.startsWith(word) || trunk.name.toLowerCase().startsWith(word))
    .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id))).slice(0, 6);
  const note = (trunk) => here.has(trunk.id) ? trunk.title || `@${trunk.handle}`
    : inRoom() ? say("rooms.mentionAdds", "Not in this room yet: mentioning brings it in")
      : kind() === "plain" ? say("rooms.mentionChooses", "Answers here from this message on")
        : on("rooms") ? say("rooms.mentionRoom", "Mentioning makes a room with both") : trunk.title || "";
  const options = found.map((trunk) => ({ id: trunk.id, handle: trunk.handle, trunk, note: note(trunk) }));
  if (inRoom() && "everyone".startsWith(word)) options.push({ id: "everyone", handle: "everyone", note: say("rooms.everyone", "Everyone here answers") });
  return options;
}
function showPicker(box) {
  const word = mentionAt(box);
  const options = word === null ? [] : pickerOptions(word);
  if (!options.length) { closePicker(); return; }
  let list = $("rooms-mentions");
  if (!list) {
    list = el("ul", "rooms-mentions");
    list.id = "rooms-mentions";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", say("rooms.mentionList", "Mention a Trunk"));
    ($("composer-dock") ?? $("chat-form"))?.prepend(list);
  }
  const form = $("chat-form");
  if (form && list.parentElement !== form) list.style.left = `${form.offsetLeft + 8}px`;
  list.replaceChildren(...options.map((option, index) => {
    const item = el("li", "rooms-option");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === 0));
    item.dataset.handle = option.handle;
    const words = el("span", "rooms-row-words");
    words.append(el("b", "", `@${option.handle}`), el("small", "", option.note));
    item.append(option.trunk ? face(option.trunk, 22) : el("span", "rooms-face rooms-face-assistant", "@"), words);
    item.addEventListener("mousedown", (event) => { event.preventDefault(); pickHandle(option.handle); });
    return item;
  }));
}
function pickHandle(handle) {
  const trunk = everyTrunk().find((t) => t.handle === handle);
  mention(trunk ?? { handle });
}
function movePick(step) {
  const items = [...($("rooms-mentions")?.children ?? [])];
  const at = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
  items.forEach((item, index) => item.setAttribute("aria-selected", String(index === (at + step + items.length) % items.length)));
}
/* Ahead of the box's own Enter (which sends): while the list is open, the keys belong to it. */
document.addEventListener("keydown", (event) => {
  const list = $("rooms-mentions");
  if (!list || document.activeElement?.id !== "prompt") return;
  const keys = { ArrowDown: () => movePick(1), ArrowUp: () => movePick(-1), Escape: closePicker,
    Enter: () => pickHandle(list.querySelector('[aria-selected="true"]')?.dataset.handle ?? ""),
    Tab: () => pickHandle(list.querySelector('[aria-selected="true"]')?.dataset.handle ?? "") };
  if (!keys[event.key] || event.isComposing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  keys[event.key]();
}, true);

/* ---------- replies signed with whoever gave them ---------- */
/** Who gave the reply at this place in the conversation (null: your assistant). */
function authorAt(index) {
  if (kind() === "trunk-chat" || kind() === "member") return info.trunk;
  const authors = info?.authors ?? [];
  const entry = [...authors].reverse().find((a) => a.from <= index);
  return entry?.trunkId ? byId(entry.trunkId) : null;
}
function signReplies() {
  const box = $("conversation");
  if (!box || !info || inRoom()) return;
  if (!TRUNK_KINDS.includes(kind()) && (info.authors?.length ?? 0) < 2) return;
  [...box.querySelectorAll(":scope > .message.assistant")].forEach((node, index) => {
    const trunk = authorAt(index);
    if (!trunk || node.dataset.trunk === trunk.id) return;
    node.querySelector(":scope > small")?.replaceWith(signed(node, trunk));
  });
}

/* ---------- starting, and staying current ---------- */
/* Talk live runs its tools as your assistant, so it is only for a conversation your assistant answers. */
globalThis.branchRooms = { handlesMentions, refresh, openRoom: (id) => openRoom(id), liveAllowed: () => kind() === "plain" };
globalThis.branchOpenRoom = (id) => (on("rooms") ? openRoom(id) : false);
function watch() {
  const box = $("conversation");
  if (!box) return;
  new MutationObserver(() => { closePop(); closePicker(); void refresh(); }).observe(box, { attributes: true, attributeFilter: ["data-session-id"] });
  new MutationObserver(() => { if (!inRoom()) { signReplies(); paintHero(); } }).observe(box, { childList: true });
  const title = $("thread-name");
  if (title) new MutationObserver(() => paintWho()).observe(title, { attributes: true, attributeFilter: ["hidden"] });
  const workspace = $("workspace");
  if (workspace) new MutationObserver(() => void refresh()).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
  $("prompt")?.addEventListener("input", (event) => { if (handlesMentions()) showPicker(event.target); else closePicker(); });
  $("prompt")?.addEventListener("blur", () => setTimeout(closePicker, 120));
  document.addEventListener("branch-run-finished", () => void refresh());
  document.addEventListener("branch-profile", () => void refresh());
  document.addEventListener("branch-language", () => void refresh());
  addEventListener("resize", closePop);
}
watch();
void refresh();
