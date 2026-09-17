// Trusted folders (wave mac2). Before Branch reads anything a folder carries for AI assistants —
// notes like AGENTS.md, lists of AI tool servers, skills, hooks — the owner sees the list and says
// whether the folder is trusted. The deciding happens on the server (src/folder-trust.ts); this
// file only shows what it says and sends the answer back. Every word is behind a key.
import { t, formatNumber } from "/i18n.js";

const $ = (id) => document.getElementById(id);

async function api(body) {
  const response = await fetch("/api/folder-trust", {
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

/** An element whose words come from a key; `values` fill {places}, and fixed words keep data-t. */
function worded(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  // Folder paths and file names can be long with no spaces; they wrap rather than widen the page.
  node.style.overflowWrap = "anywhere";
  return node;
}

const kinds = [
  ["instructions", "folder-trust.kind.notes", "folder-trust.kind.notes-note"],
  ["aiToolServers", "folder-trust.kind.servers", "folder-trust.kind.servers-note"],
  ["skills", "folder-trust.kind.skills", "folder-trust.kind.skills-note"],
  ["hooks", "folder-trust.kind.hooks", "folder-trust.kind.hooks-note"],
];

/** What one folder carries, as short lists. */
function findings(found) {
  const box = document.createElement("div");
  box.className = "card-list";
  for (const [field, title, note] of kinds) {
    const names = found[field] || [];
    if (!names.length) continue;
    const heading = document.createElement("h4");
    heading.textContent = `${t(title)} (${formatNumber(names.length)})`;
    const list = document.createElement("ul");
    for (const name of names.slice(0, 12)) list.append(plain("li", name));
    if (names.length > 12) list.append(worded("li", "folder-trust.more", "", { count: formatNumber(names.length - 12) }));
    box.append(heading, list, worded("p", note, "subtle"));
  }
  return box;
}

const placeName = (folder) => folder.project
  ? t("folder-trust.project-folder", { name: folder.project })
  : t("folder-trust.workspace");

function buttons(folder) {
  const row = document.createElement("div");
  row.className = "identity-actions";
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  for (const [decision, key, quiet] of [["trust", "action.trust-this-folder", false], ["distrust", "action.do-not-trust-this-folder", true]]) {
    const button = worded("button", key, quiet ? "quiet-button" : "");
    button.type = "button";
    button.addEventListener("click", async () => {
      try { await api({ folder: folder.folder, decision }); await refresh(); }
      catch (error) { status.textContent = error.message; }
    });
    row.append(button);
  }
  return [row, status];
}

/** The question on the chat screen, shown only while a folder with something in it is undecided. */
function askCard(folders) {
  $("folder-trust-ask")?.remove();
  const folder = folders.find((one) => one.needsAnswer);
  const chat = $("chat");
  if (!folder || !chat) return;
  const card = document.createElement("section");
  card.className = "card";
  card.id = "folder-trust-ask";
  card.setAttribute("aria-live", "polite");
  card.append(
    worded("h2", "folder-trust.ask-title"),
    worded("p", "folder-trust.ask-lead", "subtle", { place: placeName(folder) }),
    plain("p", folder.path, "subtle"),
    findings(folder.found),
    ...buttons(folder),
  );
  chat.prepend(card);
}

/** Every folder and its answer, in Settings, so a decision can be changed later. */
function settingsCard(folders) {
  let card = $("folder-trust-card");
  const after = $("firewall-card");
  if (!card) {
    if (!after) return;
    card = document.createElement("section");
    card.className = "card";
    card.id = "folder-trust-card";
    after.after(card);
  }
  card.replaceChildren(worded("h2", "settings.card.trusted-folders"), worded("p", "folder-trust.lead", "subtle"));
  for (const folder of folders) {
    const row = document.createElement("div");
    row.className = "card-row";
    const heading = document.createElement("h4");
    heading.textContent = placeName(folder);
    row.append(heading, plain("p", folder.path, "subtle"), worded("p", `folder-trust.state.${folder.trust}`),
      findings(folder.found), ...buttons(folder));
    card.append(row);
  }
}

let shown = [];
function draw() {
  askCard(shown);
  settingsCard(shown);
}
async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try {
    shown = (await api()).folders;
    draw();
  } catch { /* signed out or offline: the next look tries again */ }
}

// Signing in shows the workspace a moment before the key is kept, so wait a little for the key:
// a few short tries, then give up until the next time the window is shown.
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

// Looked at once when the page opens, after every answer, on signing in, and when the owner comes
// back to the window. Never on a timer: each look lists what every folder carries.
void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh(); });
document.addEventListener("branch-language", draw);
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchFolderTrust = { refresh };
