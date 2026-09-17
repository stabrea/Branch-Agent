// Moving in: bring your chats, memory, instructions, skills and tool servers over from another
// assistant. The first-run card offers it in one sentence; the card under Memory shows a preview
// first, lets you tick what to bring, and says afterwards what came, what did not and why.
const $ = (id) => document.getElementById(id);
const maximumUpload = 32 * 1024 * 1024;

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function make(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, onClick, className = "") {
  const node = make("button", text, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
const say = (message) => { const node = $("move-in-status"); if (node) node.textContent = message; };

/* ------------------------------------------------------------------ the card */

function buildCard() {
  const card = make("section", "", "card");
  card.id = "move-in-card";
  const path = make("input");
  path.id = "move-in-path";
  path.placeholder = "The whole path to a folder, or a .zip or .tar.gz file";
  path.maxLength = 4096;
  const pathLabel = make("label", "Or look in a folder or file on this computer");
  pathLabel.htmlFor = path.id;
  const file = make("input");
  file.type = "file";
  file.id = "move-in-file";
  file.accept = ".zip,.tar,.tgz,.gz";
  const fileLabel = make("label", "Or open a copy you were given");
  fileLabel.htmlFor = file.id;
  card.append(
    make("h2", "Bring things over from another assistant"),
    make("p", "Chats, memory, instructions, skills and tool servers from Claude Code, Codex CLI, Hermes Agent, OpenClaw or OpenCode. You see everything first and tick what to bring. Keys and sign-ins are never copied; Branch tells you which keys to add to the locker instead."),
    Object.assign(make("div", "", "card-list"), { id: "move-in-sources" }),
    pathLabel, make("div", "", "input-row"), fileLabel, file,
    Object.assign(make("p", "", "subtle"), { id: "move-in-status", role: "status" }),
    Object.assign(make("div"), { id: "move-in-preview" }),
    Object.assign(make("div"), { id: "move-in-brought" }),
  );
  card.children[4].append(path, button("Look here", () => preview({ path: path.value.trim() })));
  file.addEventListener("change", () => openFile(file.files?.[0]));
  return card;
}

async function openFile(chosen) {
  if (!chosen) return;
  if (chosen.size > maximumUpload) { say("That file is larger than the 32 MB Branch opens from the page. Give its path instead."); return; }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(chosen);
  });
  await preview({ archive: { name: chosen.name, data } });
}

async function showSources() {
  const { sources } = await api("move-in");
  const where = $("move-in-sources");
  where.replaceChildren();
  for (const entry of sources.filter((item) => item.found)) {
    const row = make("div", "", "card-row");
    const moved = Object.values(entry.moved).reduce((sum, count) => sum + count, 0);
    row.append(make("h4", entry.name), make("p", moved
      ? `Found in ${entry.folder}. ${moved} thing${moved === 1 ? "" : "s"} already brought over.`
      : `Found in ${entry.folder}.`, "subtle"),
      button("See what is there", () => preview({ source: entry.source })));
    where.append(row);
  }
  if (!where.children.length) where.append(make("p", "No other assistant's folder was found in the usual places on this computer.", "subtle"));
}

/* ------------------------------------------------------------------ the preview */

let lastRequest = null;

function itemRow(item) {
  const label = make("label", "", "check-row");
  const box = make("input");
  box.type = "checkbox";
  box.value = item.key;
  box.checked = !item.blocked && !item.alreadyMoved;
  box.disabled = item.blocked || item.alreadyMoved;
  const words = make("span", item.title);
  const detail = item.alreadyMoved ? "Already brought over." : item.detail;
  const needs = item.needsKeys.length ? ` Needs ${item.needsKeys.join(", ")} in the locker.` : "";
  label.append(box, words, make("span", ` — ${detail}${needs}`, "subtle"));
  return label;
}

function groupBlock(group) {
  const block = make("details");
  block.open = group.kind !== "chat" || group.items.length <= 20;
  const open = group.items.filter((item) => !item.blocked && !item.alreadyMoved).length;
  block.append(make("summary", `${group.name} (${group.items.length}${open !== group.items.length ? `, ${open} can come` : ""})`));
  const all = button("Tick all", () => block.querySelectorAll("input:not([disabled])").forEach((box) => { box.checked = true; }), "quiet-button");
  const none = button("Tick none", () => block.querySelectorAll("input:not([disabled])").forEach((box) => { box.checked = false; }), "quiet-button");
  block.append(make("div", "", "identity-actions"));
  block.lastChild.append(all, none);
  for (const item of group.items) block.append(itemRow(item));
  return block;
}

function keysBlock(keys, heading) {
  const block = make("div");
  if (!keys.length) return block;
  block.append(make("h3", heading));
  const list = make("ul");
  for (const key of keys) list.append(make("li", `${key.name} — ${key.why}`));
  block.append(list, make("p", "Add them under Settings → Secrets. Branch did not copy their values.", "subtle"));
  return block;
}

async function preview(request) {
  say("Reading… nothing is changed while you look.");
  $("move-in-preview").replaceChildren();
  try {
    const found = await api("move-in/preview", request);
    lastRequest = { ...request, source: found.source };
    const where = $("move-in-preview");
    where.append(make("h3", `From ${found.name}`), make("p", found.from, "subtle"));
    for (const group of found.groups) where.append(groupBlock(group));
    where.append(keysBlock(found.keys, "Keys it used"));
    for (const note of found.notes) where.append(make("p", note, "subtle"));
    if (found.groups.length) where.append(button("Bring the ticked things over", bring));
    say(found.groups.length ? "Tick what to bring, then press the button at the end." : "There is nothing here Branch can bring over.");
  } catch (error) { say(error.message); }
}

async function bring() {
  const items = [...$("move-in-preview").querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
  if (!items.length) { say("Tick at least one thing first."); return; }
  say(`Bringing ${items.length} thing${items.length === 1 ? "" : "s"} over…`);
  try {
    const receipt = await api("move-in/import", { ...lastRequest, items });
    const where = $("move-in-preview");
    where.replaceChildren(make("h3", `Brought over from ${receipt.name}`));
    const list = make("ul");
    for (const entry of receipt.brought) list.append(make("li", `${entry.title} → ${entry.target}`));
    for (const entry of receipt.skipped) list.append(make("li", `Not brought: ${entry.title} — ${entry.reason}`));
    where.append(list, keysBlock(receipt.keys, "Add these keys so what came over works"));
    say(`${receipt.brought.length} brought over, ${receipt.skipped.length} left behind.`);
    await Promise.all([showSources(), showBrought()]);
  } catch (error) { say(error.message); }
}

/* ------------------------------------------------------------------ tool servers that came over */

async function showBrought() {
  const { servers, settings } = await api("move-in/brought");
  const where = $("move-in-brought");
  where.replaceChildren();
  if (settings.model) where.append(make("p", `The model you used with ${settings.model.source}: ${settings.model.value}. Choose it under Settings when you connect a model.`));
  if (!servers.length) return;
  where.append(make("h3", "Tool servers brought over"),
    make("p", "Try each one first under Settings → Sharing with other AI tools → Try a server. To keep one, add its entry to your connections file, with the tools you want it to offer under \"tools\" and the version the try showed under \"expectedVersion\".", "subtle"));
  for (const entry of servers) {
    const row = make("details", "", "card-row");
    row.append(make("summary", `${entry.name} (from ${entry.source})`), make("pre", JSON.stringify(entry.server.connection, null, 2)));
    where.append(row);
  }
}

/* ------------------------------------------------------------------ the first-run offer */

async function offer() {
  const { offer: sentence } = await api("move-in");
  const firstRun = $("first-run");
  if (!sentence || !firstRun || $("move-in-offer")) return;
  const line = make("p", "", "first-run-lead");
  line.id = "move-in-offer";
  line.append(button(sentence, () => {
    document.querySelector('button.nav[data-view="memory"]')?.click();
    $("move-in-card")?.scrollIntoView({ block: "start" });
  }, "quiet-button"));
  firstRun.querySelector(".doors")?.after(line);
}

async function start() {
  const memory = $("memory");
  if (!memory || $("move-in-card")) return;
  memory.append(buildCard());
  // Before the owner has signed in to this page the requests are refused; the card simply stays empty.
  await Promise.all([showSources(), showBrought(), offer()]).catch(() => undefined);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
