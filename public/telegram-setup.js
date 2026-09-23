// Setting up Telegram from a card (mac3/never-break). The steps with BotFather in plain words, the
// bot's token straight into the locker (it is never shown again), the switch, and pairing the owner's
// own account with the code the bot sends. The work happens on the server; every word has a key.
import { t } from "/i18n.js";
import { segmented } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
let said = "";
let last = null;

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function worded(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function statusLine(text = "") {
  const node = document.createElement("p");
  node.className = "subtle";
  node.setAttribute("role", "status");
  node.textContent = text;
  return node;
}

function card() {
  let node = $("telegram-setup-card");
  if (node) return node;
  const after = $("channels-card");
  if (!after) return null;
  node = document.createElement("section");
  node.className = "card";
  node.id = "telegram-setup-card";
  node.dataset.home = "settings:channels";
  after.after(node);
  return node;
}

function steps() {
  const list = document.createElement("ol");
  for (const n of [1, 2, 3, 4]) list.append(worded("li", `telegram-setup.step-${n}`));
  return list;
}

function field(id, labelKey, input) {
  const label = worded("label", labelKey);
  label.htmlFor = id;
  input.id = id;
  return [label, input];
}

function tokenAndSwitch(view) {
  const token = document.createElement("input");
  Object.assign(token, { type: "password", autocomplete: "off", spellcheck: false });
  token.placeholder = t(view.tokenSaved ? "telegram-setup.token-kept" : "telegram-setup.token-placeholder");
  const mode = segmented({
    id: "telegram-setup-mode",
    options: [["off", "telegram-setup.switch.off"], ["when-needed", "telegram-setup.switch.when-needed"], ["on", "telegram-setup.switch.on"]],
    value: view.mode
  });
  const status = statusLine(said);
  said = "";
  /* DG-025: the switch is kept the moment it changes, as the sample saves, without redrawing the card
     (a token being typed stays where it is). The token is typed, so it keeps its button. */
  mode.addEventListener("change", async () => {
    try { last = await call("/api/never-break/telegram", { mode: mode.value }); status.textContent = t("telegram-setup.saved"); }
    catch (error) { mode.value = last?.mode ?? view.mode; status.textContent = error.message; }
  });
  const save = worded("button", "action.save-and-connect");
  save.type = "button";
  save.addEventListener("click", async () => {
    const body = token.value.trim() ? { token: token.value.trim() } : {};
    try { await call("/api/never-break/telegram", body); token.value = ""; said = t("telegram-setup.saved"); await refresh(); }
    catch (error) { status.textContent = error.message; }
  });
  return [...field("telegram-setup-token", "field.telegram-token", token), worded("p", "telegram-setup.token-note", "field-note"),
    ...field("telegram-setup-mode", "field.telegram-mode", mode), save, status];
}

function pairing() {
  const code = document.createElement("input");
  Object.assign(code, { inputMode: "numeric", maxLength: 6, pattern: "[0-9]{6}", autocomplete: "off" });
  const status = statusLine();
  const pair = worded("button", "action.pair-my-account", "quiet-button");
  pair.type = "button";
  pair.addEventListener("click", async () => {
    try { await call("/api/channels/pairings/approve", { code: code.value.trim() }); code.value = ""; status.textContent = t("telegram-setup.paired"); }
    catch (error) { status.textContent = error.message; }
  });
  return [worded("p", "telegram-setup.pair-lead"), ...field("telegram-setup-code", "field.telegram-code", code), pair, status];
}

function nowLine(view) {
  const key = view.connected ? "telegram-setup.now.connected" : view.tokenSaved ? "telegram-setup.now.saved" : "telegram-setup.now.nothing";
  const line = worded("p", key, "subtle");
  if (view.connected && view.botName) line.textContent = `${t(key)} @${view.botName}`;
  return line;
}

function draw(view) {
  const node = card();
  if (!node) return;
  node.replaceChildren(/* DG-008: a card on a Settings page is titled under its section's heading. */
    worded("h3", "settings.card.telegram-setup", "settings-card-title"), worded("p", "telegram-setup.lead"),
    steps(), ...tokenAndSwitch(view), nowLine(view), ...pairing(), worded("p", "telegram-setup.safety", "subtle"));
}

async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { last = await call("/api/never-break/telegram"); draw(last); }
  catch { /* signed out or offline: the next look tries again */ }
}
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh(); });
document.addEventListener("branch-language", () => { if (last) draw(last); });
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchTelegramSetup = { refresh };
