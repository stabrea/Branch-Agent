/* mac7/vault-autofill (R17-068): "Filling a saved sign-in", one card in settings:secrets, placed by
   public/layout.js through data-home. It ships off. Every word goes through a key with real French,
   every control has a label and one sentence describing it (aria-describedby), nothing is wider than
   the 400 px column, and no colour is written here.

   No password ever travels through this screen: it holds names — what the owner calls each sign-in,
   which website it belongs to, and which item in their password manager holds it. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const HOME = "settings:secrets";
const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };

function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
/** A label, the control, and one sentence describing it, tied together for screen readers. */
function described(id, key, english, hintKey, hint, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  const note = make("p", "field-note", hintKey, hint);
  note.id = `${id}-hint`;
  control.setAttribute("aria-describedby", note.id);
  return [label, control, note];
}
function field(type, value = "", placeholder = "") {
  const node = document.createElement("input");
  node.type = type;
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value ?? "";
  if (placeholder) node.placeholder = placeholder;
  if (type === "text") node.maxLength = 300;
  // A website name or an item name has no spaces to break at; it wraps rather than widening the card.
  node.style.maxWidth = "100%";
  return node;
}
function chooser(id, options, value) {
  return dropdown({ id, options, value });
}
function button(id, key, english, hintKey, hint, handler, primary = false) {
  const node = make("button", primary ? "primary" : "quiet-button", key, english);
  node.type = "button";
  node.id = id;
  node.title = say(hintKey, hint);
  node.dataset.tTitle = hintKey;
  node.setAttribute("aria-description", node.title);
  node.dataset.tAriaDescription = hintKey;
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}

const POSITIONS = [
  ["off", "vault-autofill.switch.off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "vault-autofill.switch.on", "On"],
];
const SERVICES = [
  ["bitwarden", "vault-autofill.service.bitwarden", "Bitwarden"],
  ["1password", "vault-autofill.service.1password", "1Password"],
];

let settings = { mode: "off", logins: [], timeoutMs: 10000 };

/** The card itself: the switch, what it means, and the owner's list of sign-ins. */
function card() {
  const node = make("section", "card");
  node.id = "vault-autofill";
  node.dataset.home = HOME;
  node.style.maxWidth = "400px";
  node.append(
    make("h2", "", "vault-autofill.title", "Filling a saved sign-in"),
    make("p", "subtle", "vault-autofill.intro",
      "Branch can type a password you already keep in your password manager straight into a page you are on, "
      + "when you ask it to by name. It never shows you or the assistant the password, keeps no copy of its own, "
      + "and only ever fills a page on the exact website you saved the sign-in for. While a recording of the browser "
      + "is being kept, it fills nothing at all."),
  );
  const status = make("p", "subtle");
  status.id = "vault-autofill-status";
  status.setAttribute("role", "status");
  return { node, status };
}

function switchRow() {
  const control = chooser("vault-autofill-mode", POSITIONS, settings.mode);
  return described("vault-autofill-mode", "vault-autofill.field.switch", "Filling a saved sign-in",
    "vault-autofill.hint.switch",
    "Off, Branch refuses and the assistant is not offered the tool at all. When needed, and On, "
    + "it fills one of the sign-ins below when you ask for it by name. It is yours alone: a message from a chat app, "
    + "a short-lived key, another computer, someone else on this computer and a Trunk are all refused, and so is "
    + "everything while Lockdown is on.", control);
}

/** One line of the owner's book, shown as words, never as anything that could hold a password. */
function line(entry) {
  const row = make("div", "card-list-row");
  row.style.maxWidth = "100%";
  const name = make("strong", "");
  name.textContent = entry.name;
  const where = make("span", "subtle");
  const extra = (entry.alsoHosts ?? []).length ? ` (+${entry.alsoHosts.join(", ")})` : "";
  where.textContent = ` — ${entry.site}${extra} · ${entry.item}${entry.code ? " · +code" : ""}`;
  where.style.overflowWrap = "anywhere";
  row.append(name, where, button(`vault-autofill-drop-${entry.name}`, "vault-autofill.action.remove", "Remove",
    "vault-autofill.hint.remove", "Takes this sign-in off the list. Nothing in your password manager is changed.",
    () => save({ logins: settings.logins.filter((one) => one.name !== entry.name) })));
  return row;
}

/** The form for adding one: a name, a website, the item, and whether it holds the one-time code. */
function adder() {
  const parts = [];
  parts.push(...described("vault-autofill-name", "vault-autofill.field.name", "What you will call it",
    "vault-autofill.hint.name", "The name you will ask for, in lower-case letters, digits and dashes, such as shop.",
    field("text", "", "shop")));
  parts.push(...described("vault-autofill-site", "vault-autofill.field.site", "The website it belongs to",
    "vault-autofill.hint.site", "Just the website name, such as example.com. Branch fills this sign-in on that site "
    + "and pages under it, and refuses anywhere else.", field("text", "", "example.com")));
  const also = document.createElement("textarea");
  also.rows = 2;
  also.style.maxWidth = "100%";
  parts.push(...described("vault-autofill-also", "vault-autofill.field.also", "Other website names it signs in on",
    "vault-autofill.hint.also", "Optional. Other exact website names this same sign-in may be filled on, one per line, "
    + "such as accounts.example.com. Branch never works one out for itself: if signing in happens on a different name "
    + "from the one above, write that name here.", also));
  parts.push(...described("vault-autofill-service", "vault-autofill.field.service", "Where it is saved",
    "vault-autofill.hint.service", "Which password manager holds it. Branch reads it through the password-manager connection you switched on under “Reading passwords out of your password manager”, using that manager's own command line, and can only read. A one-time code is read from Bitwarden only.",
    chooser("vault-autofill-service", SERVICES, "bitwarden")));
  parts.push(...described("vault-autofill-item", "vault-autofill.field.item", "The item in your password manager",
    "vault-autofill.hint.item", "The item's name, exactly as it appears in your password manager. Branch never "
    + "guesses which item to use from what a page says.", field("text", "", "My Shop")));
  parts.push(...described("vault-autofill-address", "vault-autofill.field.address", "The sign-in page's address",
    "vault-autofill.hint.address", "Optional. Branch will not fill a page that pressing something took it to on "
    + "another website, because what it pressed was put there by whoever wrote the page — unless the address is "
    + "this one, written here by you.",
    field("text", "", "https://example.com/login")));
  parts.push(...described("vault-autofill-code", "vault-autofill.field.code", "This item also holds the one-time code",
    "vault-autofill.hint.code", "Tick this when the same item holds your authenticator code. Branch then types the "
    + "code the same way, and sees it no more than it sees the password.", field("checkbox")));
  parts.push(button("vault-autofill-add", "vault-autofill.action.add", "Add this sign-in",
    "vault-autofill.hint.add", "Saves the names above. No password is read, asked for or kept by this.", add, true));
  return parts;
}

async function add() {
  const entry = {
    name: $("vault-autofill-name").value.trim(),
    site: $("vault-autofill-site").value.trim(),
    service: $("vault-autofill-service").value,
    item: $("vault-autofill-item").value.trim(),
    alsoHosts: $("vault-autofill-also").value.split(/[\s,]+/).map((one) => one.trim()).filter(Boolean),
    code: $("vault-autofill-code").checked,
  };
  const address = $("vault-autofill-address").value.trim();
  if (address) entry.address = address;
  await save({ logins: [...settings.logins.filter((one) => one.name !== entry.name), entry] });
  for (const id of ["vault-autofill-name", "vault-autofill-site", "vault-autofill-item", "vault-autofill-address",
    "vault-autofill-also"])
    $(id).value = "";
  $("vault-autofill-code").checked = false;
}

async function save(patch) {
  const status = $("vault-autofill-status");
  try {
    settings = await api("vault-autofill/settings", patch);
    status.dataset.t = "vault-autofill.saved";
    status.textContent = say("vault-autofill.saved", "Saved.");
    draw();
  } catch (error) {
    delete status.dataset.t;
    status.textContent = error.message ?? String(error);
  }
}

/** Redraws the list of sign-ins after a change; the switch and the form keep what was typed. */
function draw() {
  const list = $("vault-autofill-list");
  if (!list) return;
  list.replaceChildren(...(settings.logins.length
    ? settings.logins.map(line)
    : [make("p", "subtle", "vault-autofill.none", "No sign-ins yet. Add one below and Branch will fill it when you ask.")]));
  const mode = $("vault-autofill-mode");
  if (mode) mode.value = settings.mode;
}

async function start() {
  if ($("vault-autofill")) return;
  const { node, status } = card();
  const list = make("div", "card-list");
  list.id = "vault-autofill-list";
  list.setAttribute("aria-live", "polite");
  node.append(...switchRow(), status, list,
    make("h3", "", "vault-autofill.add", "Add a sign-in"), ...adder());
  document.body.append(node);
  $("vault-autofill-mode").addEventListener("change", (event) => save({ mode: event.target.value }));
  try { settings = await api("vault-autofill/settings"); } catch { /* shown as empty until it answers */ }
  draw();
}

/** The window is rebuilt by the last script on the page, so the card waits for it. */
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

whenReady(() => { void start(); });
