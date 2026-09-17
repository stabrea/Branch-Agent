/**
 * Set up a chat app, on the phone (mac7/connect): the same panel as the window's, read from the paired
 * Branch. On a phone there is nothing to scan, so the two square codes become two links: the store page
 * for this phone, and the page that makes the bot. The token is checked and saved by the Branch itself.
 */
import { t } from "/i18n.js";
import { $, phone, say } from "/phone-common.js";

const system = () => (/iphone|ipad|ipod/i.test(navigator.userAgent) ? "ios" : "android");

function worded(tag, key, english) {
  const node = document.createElement(tag);
  node.dataset.t = key;
  node.textContent = say(key, english);
  return node;
}
/** A recipe's own sentence, in French when the language file has it. */
function recipeWords(tag, view, part, english) {
  const node = document.createElement(tag);
  const key = `channel-setup.r.${view.id}.${part}`;
  node.textContent = t(key) === key ? english : t(key);
  return node;
}
function outLink(key, english, href) {
  const node = worded("a", key, english);
  Object.assign(node, { href, target: "_blank", rel: "noreferrer noopener", className: "quiet-button" });
  return node;
}

function linksFor(view) {
  const nodes = [];
  const store = view.stores?.[system()];
  if (store) nodes.push(outLink("phone.connect.store", "Get the app", store));
  else if (view.noApp) nodes.push(recipeWords("p", view, "noApp", view.noApp));
  if (view.create?.url) nodes.push(recipeWords("p", view, "how", view.create.how), outLink("phone.connect.create", "Make the bot", view.create.url));
  else if (view.create) nodes.push(recipeWords("p", view, "how", view.create.how), worded("p", "phone.connect.server-first", "This one needs your own server: make the bot on the computer."));
  else if (view.noCreate) nodes.push(recipeWords("p", view, "noCreate", view.noCreate));
  return nodes;
}

function input(view, name, what, type) {
  const label = recipeWords("label", view, type === "password" ? `paste-${name}` : `field-${name}`, what);
  const box = Object.assign(document.createElement("input"), { type, autocomplete: "off", spellcheck: false, id: `connect-${name}` });
  box.dataset.name = name;
  label.htmlFor = box.id;
  return [label, box];
}

function pasteFor(view) {
  const boxes = [...view.fields.flatMap((field) => input(view, field.name, field.what, "text")),
    ...view.paste.flatMap((paste) => input(view, paste.secret, paste.what, "password"))];
  const said = Object.assign(document.createElement("p"), { className: "subtle", id: "connect-status" });
  said.setAttribute("role", "status");
  const save = worded("button", "channel-setup.check-and-save", "Check and save");
  save.type = "button";
  save.id = "connect-save";
  save.disabled = view.mode === "off";
  save.addEventListener("click", async () => {
    const values = {};
    for (const box of boxes) if (box.tagName === "INPUT" && box.value.trim()) values[box.dataset.name] = box.value.trim();
    said.textContent = say("channel-setup.checking", "Checking…");
    try {
      const answer = await phone.vault.request("POST", `/api/channel-setup/${view.id}/check`, { values });
      for (const box of boxes) if (box.type === "password") box.value = "";
      said.textContent = answer.botName ? say("channel-setup.checked-as", "Accepted: {name}.", { name: answer.botName }) : say("channel-setup.done", "Done.");
    } catch (error) { said.textContent = error instanceof Error ? error.message : String(error); }
  });
  const off = view.mode === "off" ? [worded("p", "channel-setup.off-note", "Saving is switched off.")] : [];
  return [...boxes, ...off, save, said];
}

async function drawApp(id) {
  const body = $("connect-body");
  try {
    const view = await phone.vault.request("GET", `/api/channel-setup/${id}`);
    body.replaceChildren(...linksFor(view), ...pasteFor(view));
  } catch (error) { body.textContent = error instanceof Error ? error.message : String(error); }
}

/** Shown only when the paired Branch knows this panel. */
export async function drawConnect() {
  const card = $("connect-card");
  if (!card) return;
  let list = null;
  try { list = await phone.vault.request("GET", "/api/channel-setup"); } catch { /* an older Branch: no panel */ }
  if (!Array.isArray(list?.channels)) { card.hidden = true; return; }
  const select = $("connect-app");
  select.replaceChildren(...list.channels.map((channel) => Object.assign(document.createElement("option"), { value: channel.id, textContent: channel.name })));
  select.onchange = () => void drawApp(select.value);
  card.hidden = false;
  await drawApp(select.value);
}
