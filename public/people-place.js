/* phase2/shell: People, where everybody who uses Branch on this computer is, with faces
   (critique #11), and "Who is using Branch" (critique #23, kept as the owner loved it) on the People
   button at the foot of the strip. Also the Settings card for the strip's two switches.

   Everything here is real: household profiles (src/profiles.ts), their role, projects and daily
   allowance (src/profile-roles.ts), and, while signing in from their own device is on, where each
   person is signed in (src/people/). There is no "online" dot, because Branch does not know who is
   present; it says when each person last used Branch. Faces are drawn from each name. The owner's
   actions go through the owner's routes; a household person sees their own card and the way back. */
import { api, displayView, toast } from "/app.js";
import { formatDate } from "/i18n.js";
import { face, personSpec } from "/faces.js";
import { closePopovers, trackPopover } from "/popover.js";
import { isOwner, make, refresh, say, shell } from "/strip.js";

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
const grantOf = (id) => shell.profiles?.roles?.find((entry) => entry.profileId === id)?.grant ?? { role: "adult", projects: [], dailySpendLimit: 0 };
const ownerSpec = () => personSpec({ name: say("household.owner", "The owner") });
async function switchTo(profileId, pin) {
  await api("profiles/switch", { profileId, ...(pin ? { pin } : {}) });
  closePopovers();
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

/* ---------- the People page ---------- */
export function showPeople() {
  displayView("household:people");
  void drawPeople();
}
async function signedIn() {
  if (!isOwner()) return new Map();
  const settings = await api("people/settings").catch(() => null);
  return new Map((settings?.people ?? []).map((person) => [person.id, person.signedIn ?? []]));
}
export async function drawPeople() {
  const slot = $("lx-slot-household-people");
  if (!slot) return;
  await refresh();
  const owner = isOwner(), devices = await signedIn();
  const page = make("div", "shell-page people-page");
  const head = make("div", "shell-head");
  head.append(make("h2", "shell-title", "place.household", "People"),
    make("p", "shell-lede", "household.lede", "Everyone who uses Branch on this computer. Each person's conversations and memory are their own, and the owner decides what each may have Branch do."));
  page.append(head);
  if (owner) page.append(addPerson());
  const cards = make("div", "people-cards");
  cards.append(ownerCard(owner), ...(shell.profiles?.profiles ?? []).filter((person) => owner || person.id === shell.profiles?.active?.id)
    .map((person) => personCard(person, owner, devices.get(person.id) ?? [])));
  page.append(cards, make("p", "shell-note", "household.note", "This is separation on one computer, not separate accounts: the assistant still works with the owner's models and tools, and anyone who can open the files on this computer can read them. A role can only narrow what Branch may do, never widen it."));
  slot.replaceChildren(page);
}
function cardHead(spec, name, sub, roleKey) {
  const head = make("div", "person-head");
  const words = make("div", "grow");
  const strong = make("b");
  strong.textContent = name;
  const small = make("small");
  small.textContent = sub;
  words.append(strong, small);
  head.append(face(spec, 52, { flat: true }), words, make("span", "shell-pill", ...ROLES[roleKey]));
  return head;
}
function ownerCard(owner) {
  const card = make("article", "person-card");
  card.dataset.person = "owner";
  const you = !shell.profiles?.active;
  card.append(cardHead(ownerSpec(), say("household.owner", "The owner"), you ? say("household.usingNow", "Using Branch now") : say("household.away", "Not using Branch right now"), "owner"),
    make("p", "shell-note", ...ROLE_WORDS.owner));
  if (!owner) card.append(backToOwner());
  else card.append(button("", "household.ownerPin", "A PIN for switching back to you", () => displayView("settings:general")));
  return card;
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
function personCard(person, owner, signedInOn) {
  const grant = grantOf(person.id), card = make("article", "person-card");
  card.dataset.person = person.id;
  card.append(cardHead(personSpec(person), person.name, lastUsed(person), grant.role), make("p", "shell-note", ...ROLE_WORDS[grant.role]));
  const facts = make("dl", "shell-facts");
  const fact = (key, english, value) => { const term = make("dt", "", key, english); const said = make("dd"); said.textContent = value; facts.append(term, said); };
  fact("household.projects", "Projects", grant.projects.length ? grant.projects.join(", ") : say("household.projects.all", "All of them"));
  fact("household.allowance", "Daily allowance", grant.dailySpendLimit > 0 ? grant.dailySpendLimit.toFixed(2) : say("household.allowance.none", "None"));
  if (signedInOn.length) fact("household.devices", "Signed in on", signedInOn.map((entry) => entry.device).join(", "));
  card.append(facts);
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
  acts.append(roles, button("", "household.switchTo", "Switch to {name}", () => askPinOnCard(acts, person), { name: person.name }),
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
function addPerson() {
  const form = make("form", "person-add");
  const name = document.createElement("input");
  name.id = "household-add-name";
  name.maxLength = 40;
  name.autocomplete = "off";
  name.placeholder = say("household.add.name", "Their name");
  name.dataset.tPlaceholder = "household.add.name";
  name.setAttribute("aria-label", say("household.add.name", "Their name"));
  const pin = pinField("household-add-pin", "household.add.pin", "Their PIN, four to eight digits");
  const go = make("button", "studio-primary", "household.add", "Add someone");
  go.type = "submit";
  form.append(name, pin, go);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void api("profiles", { name: name.value.trim(), pin: pin.value })
      .then(async () => { toast(say("household.added", "{name} is added. They switch to their own profile with their PIN.", { name: name.value.trim() })); await drawPeople(); })
      .catch((error) => toast(error.message));
  });
  return form;
}

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
  words.append(make("b", "", key, english), make("small", "", noteKey, note));
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
