// Trusted folders (wave mac2). Before Branch reads anything a folder carries for AI assistants —
// notes like AGENTS.md, lists of AI-tool servers, skills, hooks — the owner sees the list and says
// whether the folder is trusted. The deciding happens on the server (src/folder-trust.ts); this
// file only shows what it says and sends the answer back.
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

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const kinds = [
  ["instructions", "Notes for AI assistants", "Branch reads these into every task in this folder once you trust it."],
  ["aiToolServers", "AI-tool servers it asks to connect", "Shown so you know they are there. Branch does not start them from a folder."],
  ["skills", "Skills", "Shown so you know they are there. Branch does not load skills from a folder."],
  ["hooks", "Commands it asks to run automatically", "Shown so you know they are there. Branch does not run a folder's own hooks."],
];

/** What one folder carries, as short lists. */
function findings(found) {
  const box = element("div", "", "card-list");
  for (const [key, title, note] of kinds) {
    const names = found[key] || [];
    if (!names.length) continue;
    box.append(element("h4", `${title} (${names.length})`));
    const list = element("ul");
    for (const name of names.slice(0, 12)) list.append(element("li", name));
    if (names.length > 12) list.append(element("li", `and ${names.length - 12} more`));
    box.append(list, element("p", note, "subtle"));
  }
  return box;
}

const trustWords = {
  trusted: "Trusted: its notes are read.",
  untrusted: "Not trusted: nothing in it is read, and every change waits for your yes.",
  unknown: "Not decided yet: nothing in it is read until you say.",
};

function buttons(folder, onDone) {
  const row = element("div", "", "identity-actions");
  const status = element("p", "", "subtle");
  status.setAttribute("role", "status");
  for (const [decision, words, quiet] of [["trust", "Trust this folder", false], ["distrust", "Don't trust it", true]]) {
    const button = element("button", words, quiet ? "quiet-button" : "");
    button.type = "button";
    button.addEventListener("click", async () => {
      try { await api({ folder: folder.folder, decision }); await onDone(); }
      catch (error) { status.textContent = error.message; }
    });
    row.append(button);
  }
  return [row, status];
}

/** The question on the chat screen, shown only while a folder with something in it is undecided. */
function askCard(folders) {
  $("folder-trust-ask")?.remove();
  const waiting = folders.filter((folder) => folder.needsAnswer);
  const chat = $("chat");
  if (!waiting.length || !chat) return;
  const card = element("section", "", "card");
  card.id = "folder-trust-ask";
  card.setAttribute("aria-live", "polite");
  const folder = waiting[0];
  card.append(
    element("h2", "Do you trust this folder?"),
    element("p", `${folder.label} (${folder.path}) holds things meant to steer an AI assistant. Until you decide, Branch reads none of them. If you did not make this folder or do not know where it came from, choose "Don't trust it": Branch will then read nothing from it and ask before every change.`),
    findings(folder.found),
    ...buttons(folder, refresh),
  );
  chat.prepend(card);
}

/** Every folder and its answer, in Settings, so a decision can be changed later. */
function settingsCard(folders) {
  let card = $("folder-trust-card");
  const after = $("firewall-card");
  if (!card) {
    if (!after) return;
    card = element("section", "", "card");
    card.id = "folder-trust-card";
    after.after(card);
  }
  card.replaceChildren(
    element("h2", "Trusted folders"),
    element("p", "A folder can carry notes and settings meant for AI assistants. Branch uses them only from folders you trust. A folder you do not trust is read from nothing, and every change in it waits for your yes."),
  );
  for (const folder of folders) {
    const row = element("div", "", "card-row");
    row.append(element("h4", folder.label), element("p", folder.path, "subtle"), element("p", trustWords[folder.trust] || ""));
    row.append(findings(folder.found), ...buttons(folder, refresh));
    card.append(row);
  }
}

async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try {
    const { folders } = await api();
    askCard(folders);
    settingsCard(folders);
  } catch { /* signed out or offline: the next refresh tries again */ }
}

void refresh();
setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 20000);
window.branchFolderTrust = { refresh };
