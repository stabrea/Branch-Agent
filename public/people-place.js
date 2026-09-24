/* phase2/shell: People, where everybody who uses Branch on this computer is, with faces
   (critique #11), and "Who is using Branch" (critique #23, kept as the owner loved it) on the People
   button at the foot of the strip. Also the Settings card for the strip's two switches.

   Everything here is real: household profiles (src/profiles.ts), their role, projects and daily
   allowance (src/profile-roles.ts), and, while signing in from their own device is on, where each
   person is signed in (src/people/). There is no "online" dot, because Branch does not know who is
   present; it says when each person last used Branch. Faces are drawn from each name. The owner's
   actions go through the owner's routes; a household person sees their own card and the way back. */
import { api, displayView, noteWindowProfile, toast } from "/app.js";
import { formatDate } from "/i18n.js";
import { face, personSpec } from "/faces.js";
import { closePopovers, trackPopover } from "/popover.js";
import { icon, isOwner, make, refresh, say, shell } from "/strip.js";

const $ = (id) => document.getElementById(id);
const ROLES = { owner: ["household.role.owner", "Owner"], adult: ["household.role.adult", "Adult"], child: ["household.role.child", "Child"] };
const ROLE_WORDS = {
  owner: ["household.role.owner.words", "May do anything, including changing how Branch is set up and spending money."],
  adult: ["household.role.adult.words", "May read, write files, run commands, use web pages and send messages. May not change how Branch is set up, or spend money."],
  child: ["household.role.child.words", "May look things up and answer questions. Nothing that changes a file, runs a command, sends a message or spends money."],
};
function button(className, key, english, handler, values) {
  const node = make("button", /glass-option/.test(className) ? className : `shell-btn ${className}`.trim(), key, english, values);
  node.type = "button";
  node.addEventListener("click", () => void Promise.resolve(handler()).catch((error) => toast(error.message ?? String(error))));
  return node;
}
function pinField(id, key, english) {
  const input = document.createElement("input");
  input.type = "password";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.id = id;
  input.maxLength = 8;
  input.placeholder = say(key, english);
  input.dataset.tPlaceholder = key;
  input.setAttribute("aria-label", say(key, english));
  return input;
}
const formatWhen = (iso) => formatDate(iso, { dateStyle: "medium", timeStyle: "short" });
const roleOf = (id) => shell.profiles?.roles?.find((entry) => entry.profileId === id) ?? null;
const grantOf = (id) => roleOf(id)?.grant ?? { role: "adult", projects: [], dailySpendLimit: 0 };
const ownerSpec = () => personSpec({ name: say("household.owner", "The owner") });
async function switchTo(profileId, pin) {
  await api("profiles/switch", { profileId, ...(pin ? { pin } : {}) });
  closePopovers();
  noteWindowProfile(profileId === null, { force: true });
  await refresh();
  document.dispatchEvent(new CustomEvent("branch-profile-switched"));
  toast(profileId ? say("household.switched", "Switched.") : say("household.back", "Back to the owner."));
}

/* ---------- Who is using Branch ---------- */
export function whoMenu(anchor) {
  if ($("who-menu")) { closePopovers(); $("who-menu")?.remove(); return; }
  closePopovers();
  const menu = make("div", "glass-list who-menu");
  menu.id = "who-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", say("strip.who", "Who is using Branch"));
  const head = make("p", "glass-group-label", "strip.who", "Who is using Branch");
  const people = shell.profiles?.profiles ?? [], active = shell.profiles?.active?.id ?? null;
  menu.append(head, whoRow(null, ownerSpec(), say("household.owner", "The owner"), say("household.role.owner", "Owner"), active === null),
    ...people.map((person) => whoRow(person.id, personSpec(person), person.name, say(...ROLES[grantOf(person.id).role]), active === person.id)));
  menu.append(Object.assign(make("div", "strip-menu-gap"), { role: "separator" }),
    button("glass-option strip-option", "household.open", "People…", () => { closePopovers(); showPeople(); }));
  document.body.append(menu);
  const box = anchor.getBoundingClientRect(), wide = box.right + 8 + menu.offsetWidth < innerWidth;
  menu.style.left = `${wide ? box.right + 8 : Math.max(6, Math.min(innerWidth - menu.offsetWidth - 6, box.left))}px`;
  menu.style.top = `${Math.max(6, wide ? box.bottom - menu.offsetHeight : box.top - menu.offsetHeight - 8)}px`;
  trackPopover(anchor, menu, () => { menu.remove(); anchor.setAttribute("aria-expanded", "false"); });
  anchor.setAttribute("aria-expanded", "true");
  menu.querySelector(".glass-option")?.focus();
}
function whoRow(profileId, spec, name, role, current) {
  const row = make("button", "glass-option strip-option who-row");
  row.type = "button";
  row.setAttribute("role", "menuitemradio");
  row.setAttribute("aria-checked", String(current));
  row.dataset.profile = profileId ?? "owner";
  const words = make("span", "who-words");
  const strong = make("b");
  strong.textContent = name;
  const small = make("small");
  small.textContent = role;
  words.append(strong, small);
  row.append(face(spec, 26), words);
  row.addEventListener("click", () => {
    if (current) return;
    const needsPin = profileId !== null || shell.profiles?.ownerPin;
    if (!needsPin) return void switchTo(null).catch((error) => toast(error.message));
    askPin(row, profileId);
  });
  return row;
}
function askPin(row, profileId) {
  row.parentElement.querySelector(".who-pin")?.remove();
  const form = make("form", "who-pin");
  const pin = pinField("who-pin-input", profileId ? "household.pin" : "people.back.pin", profileId ? "Their PIN" : "The owner's PIN");
  const go = make("button", "studio-primary", "household.switch", "Switch");
  go.type = "submit";
  form.append(pin, go);
  form.addEventListener("submit", (event) => { event.preventDefault(); void switchTo(profileId, pin.value).catch((error) => toast(error.message)); });
  row.after(form);
  pin.focus();
}

/* ---------- the People page ----------
   Each card says what that person may have Branch do, one line per kind, from the grant Branch
   really holds them to (their role, narrowed by any group they are in), then their Trunks,
   projects, daily allowance and PIN. The owner adds somebody through "Invite someone". */
const KINDS = [["read", "household.cap.read", "Look things up"], ["browse", "household.cap.browse", "Use web pages"],
  ["files", "household.cap.files", "Write files"], ["commands", "household.cap.commands", "Run commands"],
  ["message", "household.cap.message", "Send messages"], ["spend", "household.cap.spend", "Spend money"],
  ["settings", "household.cap.settings", "Change how Branch is set up"]];
export function showPeople() {
  displayView("household:people");
  void drawPeople();
}
/** Settings › Trunks & people: straight to one person's card on the People page. */
export async function showPerson(id) {
  displayView("household:people");
  await drawPeople();
  const card = document.querySelector(`.person-card[data-person="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.focus({ preventScroll: true });
}
/** What only the owner may read (each person's sign-ins), or, for a person, the Trunks they may reach. */
async function ownerFacts() {
  if (!isOwner()) {
    // Their own view of /api/trunks has no Trunk list, only their rooms, each naming its Trunks.
    const mine = await api("trunks").catch(() => null);
    const names = (mine?.rooms ?? []).flatMap((room) => (room.roster ?? []).map((trunk) => trunk.name));
    return { people: new Map(), trunks: [...new Set(names)] };
  }
  const settings = await api("people/settings").catch(() => null);
  return { people: new Map((settings?.people ?? []).map((person) => [person.id, person])), trunks: null };
}
export async function drawPeople() {
  const slot = $("lx-slot-household-people");
  if (!slot) return;
  await refresh();
  const owner = isOwner(), facts = await ownerFacts();
  const page = make("div", "shell-page people-page");
  const head = make("div", "shell-head");
  head.append(make("p", "shell-eyebrow", "household.eyebrow", "This computer"),
    make("h2", "shell-title", "place.household", "People"),
    make("p", "shell-lede", "household.lede", "Everyone who uses Branch on this computer. Each person's conversations and memory are their own, and the owner decides what each may have Branch do."));
  page.append(head);
  if (owner) page.append(pageActions());
  const cards = make("div", "people-cards");
  cards.append(ownerCard(owner), ...(shell.profiles?.profiles ?? []).filter((person) => owner || person.id === shell.profiles?.active?.id)
    .map((person) => personCard(person, owner, facts)));
  page.append(cards, make("p", "shell-note people-foot", "household.note", "This is separation on one computer, not separate accounts: the assistant still works with the owner's models and tools, and anyone who can open the files on this computer can read them. A role can only narrow what Branch may do, never widen it."));
  slot.replaceChildren(page);
}
function pageActions() {
  const acts = make("div", "people-acts");
  const invite = withIcon(button("studio-primary", null, null, () => openInvite()), "plus", "household.invite", "Invite someone");
  invite.id = "people-invite";
  acts.append(invite, button("", "household.ownerPin", "A PIN for switching back to you", () => displayView("settings:general")));
  return acts;
}
/** A button with a mark before its words; the words carry the key, so a new language keeps the mark. */
function withIcon(node, name, key, english) {
  const mark = icon(name);
  mark.setAttribute("aria-hidden", "true");
  node.append(mark, make("span", "", key, english));
  return node;
}
function cardHead(spec, name, sub, roleKey) {
  const head = make("div", "person-head");
  const words = make("div", "grow");
  const strong = make("b");
  strong.textContent = name;
  const small = make("small");
  small.textContent = sub;
  words.append(strong, small);
  head.append(face(spec, 52, { flat: true }), words, make("span", `shell-pill${roleKey === "owner" ? " ok" : ""}`, ...ROLES[roleKey]));
  return head;
}
function newCard(id, name) {
  const card = make("article", "person-card");
  card.dataset.person = id;
  card.tabIndex = -1;
  card.setAttribute("aria-label", name);
  return card;
}
/** One line per kind, ticked or crossed from the kinds Branch really allows this person. */
function mayList(allowed) {
  const list = make("ul", "person-may");
  for (const [kind, key, english] of KINDS) {
    const on = allowed.includes(kind), item = make("li", on ? "yes" : "no");
    item.dataset.kind = kind;
    const mark = icon(on ? "check" : "close");
    mark.setAttribute("aria-hidden", "true");
    item.append(mark, make("span", "", key, english), make("span", "sr-only", on ? "household.may.yes" : "household.may.no", on ? "(allowed)" : "(not allowed)"));
    list.append(item);
  }
  return list;
}
function factList(rows) {
  const facts = make("dl", "shell-facts person-facts");
  for (const [key, english, value] of rows) {
    const said = make("dd");
    said.textContent = value;
    facts.append(make("dt", "", key, english), said);
  }
  return facts;
}
function ownerCard(owner) {
  const name = say("household.owner", "The owner"), card = newCard("owner", name);
  const you = !shell.profiles?.active;
  card.append(cardHead(ownerSpec(), name, you ? say("household.usingNow", "Using Branch now") : say("household.away", "Not using Branch right now"), "owner"),
    make("p", "p-words", ...ROLE_WORDS.owner), mayList(KINDS.map(([kind]) => kind)),
    factList([["household.trunks", "Trunks", say("household.projects.all", "All of them")],
      ["household.projects", "Projects", say("household.projects.all", "All of them")],
      ["household.allowance", "Daily allowance", say("household.allowance.none", "None")],
      ["household.pinFact", "PIN", shell.profiles?.ownerPin ? say("household.pin.set", "Set: switching back asks for it") : say("household.pin.off", "Off")]]));
  if (!owner) card.append(backToOwner());
  else card.append(changeLook());
  return card;
}
/* The look Branch has is the owner's own (Settings › Appearance); household profiles keep a face
   drawn from their name, so only the owner's card offers it. */
function changeLook() {
  const acts = make("div", "person-acts");
  const look = withIcon(button("shell-ghost", null, null, () => displayView("settings:appearance")), "leaf", "household.changeLook", "Change look");
  acts.append(look);
  return acts;
}
function backToOwner() {
  const form = make("form", "person-acts");
  const pin = shell.profiles?.ownerPin ? pinField("household-owner-pin", "people.back.pin", "The owner's PIN") : null;
  const go = make("button", "studio-primary", "people.back", "Back to the owner");
  go.type = "submit";
  form.append(...(pin ? [pin] : []), go);
  form.addEventListener("submit", (event) => { event.preventDefault(); void switchTo(null, pin?.value).catch((error) => toast(error.message)); });
  return form;
}
function lastUsed(person) {
  if (shell.profiles?.active?.id === person.id) return say("household.usingNow", "Using Branch now");
  return person.lastUsedAt ? say("household.lastUsed", "Last used {when}", { when: formatWhen(person.lastUsedAt) }) : say("household.never", "Has not used Branch yet");
}
/** The Trunks a person may reach: those in the rooms they were let into. */
function trunksOf(id, facts) {
  if (facts.trunks) return facts.trunks;
  const names = new Map((shell.roster?.trunks ?? []).map((trunk) => [trunk.id, trunk.name]));
  const ids = new Set((shell.roster?.rooms ?? []).filter((room) => room.people?.includes(id)).flatMap((room) => room.members));
  return [...ids].map((trunk) => names.get(trunk)).filter(Boolean);
}
function personCard(person, owner, facts) {
  // The ticks, projects and allowance come from the grant Branch enforces (role caps and groups
  // applied on the server), never from the saved grant's own list of kinds.
  const grant = grantOf(person.id), held = facts.people.get(person.id), entry = roleOf(person.id);
  const effective = entry?.effective ?? grant, allowed = entry?.categories ?? [];
  const card = newCard(person.id, person.name), trunks = trunksOf(person.id, facts);
  const rows = [["household.trunks", "Trunks", trunks.length ? trunks.join(", ") : say("household.allowance.none", "None")],
    ["household.projects", "Projects", effective.projects.length ? effective.projects.join(", ") : say("household.projects.all", "All of them")],
    ["household.allowance", "Daily allowance", effective.dailySpendLimit > 0 ? effective.dailySpendLimit.toFixed(2) : say("household.allowance.none", "None")],
    ["household.pinFact", "PIN", say("household.pin.isSet", "Set")]];
  if (held?.signedIn?.length) rows.push(["household.devices", "Signed in on", held.signedIn.map((entry) => entry.device).join(", ")]);
  card.append(cardHead(personSpec(person), person.name, lastUsed(person), grant.role), make("p", "p-words", ...ROLE_WORDS[grant.role]),
    mayList(allowed), factList(rows));
  if (owner) card.append(personActions(person, grant));
  return card;
}
function personActions(person, grant) {
  const acts = make("div", "person-acts");
  const roles = make("div", "studio-seg");
  roles.setAttribute("role", "group");
  roles.setAttribute("aria-label", say("household.whatMay", "What {name} may do", { name: person.name }));
  for (const role of ["adult", "child"]) {
    const pick = button("", ...ROLES[role], async () => { await api(`profiles/${person.id}/role`, { role }); toast(say("household.saved", "Saved.")); await drawPeople(); });
    pick.setAttribute("aria-pressed", String(grant.role === role));
    roles.append(pick);
  }
  acts.append(button("studio-primary", "household.switchTo", "Switch to {name}", () => askPinOnCard(acts, person), { name: person.name }), roles,
    button("studio-danger", "household.remove", "Remove", () => removePerson(acts, person)));
  return acts;
}
function askPinOnCard(acts, person) {
  acts.querySelector(".who-pin")?.remove();
  const form = make("form", "who-pin");
  const pin = pinField(`household-pin-${person.id}`, "household.pin", "Their PIN");
  const go = make("button", "studio-primary", "household.switch", "Switch");
  go.type = "submit";
  form.append(pin, go);
  form.addEventListener("submit", (event) => { event.preventDefault(); void switchTo(person.id, pin.value).then(drawPeople).catch((error) => toast(error.message)); });
  acts.append(form);
  pin.focus();
}
function removePerson(acts, person) {
  acts.querySelector(".person-confirm")?.remove();
  const bar = make("div", "person-confirm");
  bar.setAttribute("role", "alertdialog");
  bar.append(make("span", "", "household.remove.ask", "Remove {name}? Their conversations and saved facts go with them.", { name: person.name }),
    button("", "studio.keep", "Keep it", () => bar.remove()),
    button("studio-danger", "household.remove", "Remove", async () => { await api(`profiles/${person.id}/remove`, {}); await drawPeople(); }));
  acts.append(bar);
}

/* ---------- Invite someone: one dialog, on this computer or on their own device ---------- */
const invite = { tab: "here", role: "adult" };
async function openInvite(tab = "here") {
  if (!isOwner()) return;
  const { openDialog } = await import("/studio.js");
  const body = openDialog("household.invite.title", "Invite someone");
  body.classList.add("studio-small", "person-invite");
  invite.tab = tab;
  await drawInvite(body);
}
async function drawInvite(body) {
  const tabs = make("div", "studio-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", say("household.invite.title", "Invite someone"));
  for (const [id, key, english] of [["here", "household.invite.here", "On this computer"], ["device", "household.invite.device", "On their own device"]]) {
    const tab = button("studio-tab", key, english, () => { invite.tab = id; return drawInvite(body); });
    tab.setAttribute("role", "tab");
    tab.dataset.tab = id;
    tab.setAttribute("aria-selected", String(invite.tab === id));
    tabs.append(tab);
  }
  const panel = make("div", "studio-panel");
  panel.setAttribute("role", "tabpanel");
  body.replaceChildren(tabs, panel);
  if (invite.tab === "here") herePanel(panel);
  else await devicePanel(panel);
}
function inviteField(id, key, english, input) {
  const label = make("label", "studio-field");
  input.id = id;
  label.append(make("span", "", key, english), input);
  return label;
}
function herePanel(panel) {
  const name = document.createElement("input");
  name.maxLength = 40;
  name.autocomplete = "off";
  const pin = pinField("household-add-pin", "household.add.pin", "Their PIN, four to eight digits");
  pin.placeholder = "";
  delete pin.dataset.tPlaceholder;
  const roles = make("div", "studio-seg");
  roles.setAttribute("role", "group");
  roles.setAttribute("aria-label", say("household.invite.role", "Role"));
  const words = make("small", "shell-note", ...ROLE_WORDS[invite.role]);
  for (const role of ["adult", "child"]) {
    const pick = button("", ...ROLES[role], () => {
      invite.role = role;
      for (const other of roles.children) other.setAttribute("aria-pressed", String(other === pick));
      words.dataset.t = ROLE_WORDS[role][0];
      words.textContent = say(...ROLE_WORDS[role]);
    });
    pick.setAttribute("aria-pressed", String(invite.role === role));
    roles.append(pick);
  }
  const role = make("div", "studio-field");
  role.append(make("span", "", "household.invite.role", "Role"), roles, words);
  const problem = make("p", "person-invite-problem");
  problem.setAttribute("role", "alert");
  const form = make("form", "person-invite-form");
  const foot = make("div", "studio-foot");
  const add = make("button", "shell-btn studio-primary", "household.invite.add", "Add them");
  add.type = "submit";
  foot.append(make("span", "grow"), add);
  form.append(inviteField("household-add-name", "household.invite.name", "Name", name), role,
    inviteField("household-add-pin", "household.add.pin", "Their PIN, four to eight digits", pin), problem, foot);
  form.addEventListener("submit", (event) => { event.preventDefault(); void addPerson(name, pin, problem); });
  panel.append(form);
  name.focus();
}
/** Checks the two fields here first, so a slip is said beside them, then adds the person. */
async function addPerson(name, pin, problem) {
  const said = name.value.trim();
  const slip = !said ? ["household.invite.noName", "Write their name."]
    : !/^\d{4,8}$/.test(pin.value) ? ["household.invite.badPin", "A PIN is four to eight digits."] : null;
  problem.dataset.t = slip?.[0] ?? "";
  problem.textContent = slip ? say(...slip) : "";
  if (slip) return void (slip[0] === "household.invite.noName" ? name : pin).focus();
  try {
    await api("profiles", { name: said, pin: pin.value, role: invite.role });
  } catch (error) {
    delete problem.dataset.t;
    problem.textContent = error.message ?? String(error);
    return;
  }
  (await import("/studio.js")).closeDialog(true);
  toast(say("household.added", "{name} is added. They switch to their own profile with their PIN.", { name: said }));
  await drawPeople();
}
/** Their own device: the real /people address while signing in from another device is on. */
async function devicePanel(panel) {
  const settings = await api("people/settings").catch(() => null);
  if ((settings?.settings?.mode ?? "off") === "off") {
    panel.append(make("p", "", "household.invite.deviceOff", "Signing in from their own device is off. Switch it on in Settings › General, then come back here."),
      button("", "household.invite.openSettings", "Open Settings › General", async () => { (await import("/studio.js")).closeDialog(true); displayView("settings:general"); }));
    return;
  }
  const where = make("code", "person-invite-address");
  where.textContent = `${location.origin}/people`;
  panel.append(make("p", "", "household.invite.deviceWords", "They open this computer's address followed by /people on their own phone or laptop, and sign in with their name and PIN. Each person sees only their own conversations and what you share."), where);
}

/* ---------- Settings › Trunks & people: a way to each person's card, in the sample's "A person's card" section ---------- */
function drawSettingsPeople() {
  const card = $("settings-person-card");
  if (!card) return; // Settings is not drawn yet; public/settings-trunks.js says when it is (branch-settings-trunks)
  card.querySelector(".settings-people")?.remove();
  if (!isOwner()) return;
  const list = make("ul", "settings-people");
  const everyone = [{ id: "owner", spec: ownerSpec(), name: say("household.owner", "The owner"), role: "owner" },
    ...(shell.profiles?.profiles ?? []).map((person) => ({ id: person.id, spec: personSpec(person), name: person.name, role: grantOf(person.id).role }))];
  for (const person of everyone) {
    const item = make("li"), row = make("button", "settings-person");
    row.type = "button";
    row.dataset.person = person.id;
    const words = make("span", "who-words");
    const strong = make("b");
    strong.textContent = person.name;
    words.append(strong, make("small", "", ...ROLES[person.role]));
    row.append(face(person.spec, 32), words);
    row.addEventListener("click", () => void showPerson(person.id).catch((error) => toast(error.message)));
    item.append(row);
    list.append(item);
  }
  const open = card.querySelector(".settings-trunks-open");
  if (open) open.after(list); else card.append(list);
}
document.addEventListener("branch-settings-trunks", drawSettingsPeople);
document.addEventListener("branch-strip", drawSettingsPeople);
document.addEventListener("branch-profile", drawSettingsPeople);
document.addEventListener("branch-language", drawSettingsPeople);
document.addEventListener("branch-place", (event) => { if (event.detail?.page === "trunks") drawSettingsPeople(); });

/* ---------- Settings › Appearance: the strip and 3D faces ---------- */
function lookSwitch(id, key, english, noteKey, note, on, change) {
  const label = make("label", "shell-switch");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = on;
  box.disabled = !isOwner();
  box.addEventListener("change", async () => {
    try { await api("shell-look", change(box.checked)); await refresh(); } catch (error) { box.checked = !box.checked; toast(error.message); }
  });
  const words = make("span");
  // A screen reader reads the note with the switch, and the settings check finds its description.
  const small = make("small", "field-note", noteKey, note);
  small.id = `${id}-note`;
  box.setAttribute("aria-describedby", small.id);
  words.append(make("b", "", key, english), small);
  label.append(box, words);
  return label;
}
export function settingsCard() {
  const card = $("shell-look-card") ?? make("section", "card");
  const drawn = `${shell.look.strip}:${shell.look.faces3d}:${isOwner()}`;
  if (card.dataset.drawn === drawn) return card;
  card.dataset.drawn = drawn;
  card.id = "shell-look-card";
  card.dataset.home = "settings:appearance";
  card.replaceChildren(make("h2", "", "shellLook.title", "The strip and faces"),
    lookSwitch("shell-look-strip", "shellLook.strip", "Trunks strip", "shellLook.strip.note", "The narrow strip at the left edge with this computer, your other computers and your Trunks. Off gives the window without it.",
      shell.look.strip !== "off", (on) => ({ strip: on ? "on" : "off" })),
    lookSwitch("shell-look-3d", "shellLook.faces3d", "3D faces", "shellLook.faces3d.note", "Trunks set to the 3D stand-in show as a thick tile that turns slowly. Off, every face is flat.",
      shell.look.faces3d === "on", (on) => ({ faces3d: on ? "on" : "off" })));
  if (!card.isConnected) document.body.append(card);
  return card;
}
document.addEventListener("branch-strip", () => settingsCard());
document.addEventListener("branch-place", (event) => { if (event.detail?.place === "household") void drawPeople(); });
