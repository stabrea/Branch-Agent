// FQ-operations.sandbox-lifecycle: a folder of its own for a task you want kept apart from your
// workspace. Its network and the model services it may call are settled the moment it is created and
// never move afterwards — not when it is stopped, not when it is restored. Snapshot it before a risky
// change, stop it when you are done with it, or restore it from an earlier snapshot. The deciding
// happens on the server (src/agent-sandbox-lifecycle.ts); this card only shows what is there and sends
// the owner's choices back. Every word is behind a key.
import { t, formatDate } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const networks = ["none", "limited", "per-site", "open"];

async function api(path, body) {
  const response = await fetch(`/api/agent-sandboxes${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("agent-sandbox.failed"));
  return data;
}

function worded(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

function labelFor(id, key) {
  const label = worded("label", key);
  label.htmlFor = id;
  return label;
}

function say(text) {
  const node = $("agent-sandbox-card")?.querySelector("[role=status]");
  if (node) node.textContent = text;
}

function providerList(value) {
  return value.split(/[,\n]+/).map((each) => each.trim()).filter(Boolean);
}

async function createSandbox() {
  try {
    const name = $("agent-sandbox-name").value.trim();
    const network = $("agent-sandbox-network").value;
    const providers = providerList($("agent-sandbox-providers").value);
    await api("", { name, network, inference: { providers } });
    await refresh();
    say(t("agent-sandbox.created"));
  } catch (error) { say(error.message); }
}
async function stopSandbox(id) {
  try { await api("/stop", { id }); await refresh(); say(t("agent-sandbox.stopped")); }
  catch (error) { say(error.message); }
}
async function snapshotSandbox(id) {
  try { await api("/snapshot", { id }); await refresh(); say(t("agent-sandbox.snapshotted")); }
  catch (error) { say(error.message); }
}
async function restoreSandbox(id, snapshotId) {
  try { await api("/restore", { id, snapshotId }); await refresh(); say(t("agent-sandbox.restored")); }
  catch (error) { say(error.message); }
}

function snapshotRow(sandboxId, snapshot) {
  const row = document.createElement("div");
  row.className = "card-row";
  const label = snapshot.label || t("agent-sandbox.snapshot-untitled");
  row.append(document.createTextNode(`${label} — ${formatDate(snapshot.createdAt)}`));
  const restore = worded("button", "agent-sandbox.restore");
  restore.type = "button";
  restore.addEventListener("click", () => void restoreSandbox(sandboxId, snapshot.id));
  row.append(restore);
  return row;
}

function sandboxRow(sandbox) {
  const row = document.createElement("div");
  row.className = "card-row";
  const title = document.createElement("h4");
  title.textContent = sandbox.name + " — ";
  title.append(worded("span", sandbox.status === "running" ? "agent-sandbox.state.running" : "agent-sandbox.state.stopped", "subtle"));
  const detail = document.createElement("p");
  detail.className = "subtle";
  detail.textContent = t("agent-sandbox.row-detail", {
    network: t(`agent-sandbox.network.${sandbox.network}`),
    providers: sandbox.inference.providers.join(", "),
  });
  row.append(title, detail);

  const stop = worded("button", "agent-sandbox.stop");
  stop.type = "button";
  stop.hidden = sandbox.status !== "running";
  stop.addEventListener("click", () => void stopSandbox(sandbox.id));
  const snapshot = worded("button", "agent-sandbox.snapshot");
  snapshot.type = "button";
  snapshot.addEventListener("click", () => void snapshotSandbox(sandbox.id));
  row.append(stop, snapshot);

  const snapshots = document.createElement("div");
  snapshots.className = "agent-sandbox-snapshots";
  if (!sandbox.snapshots.length) snapshots.append(worded("p", "agent-sandbox.snapshots-empty", "subtle"));
  else for (const snap of sandbox.snapshots) snapshots.append(snapshotRow(sandbox.id, snap));
  row.append(snapshots);
  return row;
}

function card() {
  let section = $("agent-sandbox-card");
  if (section) return section;
  // Anchored to the static firewall-card (like public/os-sandbox.js) rather than os-sandbox-card,
  // which is itself built asynchronously after sign-in and so is not reliably there yet.
  // public/settings-grown.js then puts every card of "settings:computer" into the bucket order in
  // public/settings-buckets.js regardless of where it first lands in the DOM.
  const after = $("firewall-card");
  if (!after) return null;
  section = document.createElement("section");
  section.className = "card";
  section.id = "agent-sandbox-card";
  section.dataset.home = "settings:computer";
  section.dataset.scope = "computer";
  after.after(section);
  return section;
}

function draw(data) {
  const section = card();
  if (!section) return;

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "agent-sandbox-name";
  nameInput.maxLength = 80;

  const networkControl = dropdown({
    id: "agent-sandbox-network",
    options: networks.map((value) => [value, `agent-sandbox.network.${value}`]),
    value: "none",
  });

  const providersInput = document.createElement("input");
  providersInput.type = "text";
  providersInput.id = "agent-sandbox-providers";
  providersInput.placeholder = "anthropic, openai";

  const create = worded("button", "agent-sandbox.create");
  create.type = "button";

  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");

  const list = document.createElement("div");
  list.id = "agent-sandbox-list";
  if (!data.sandboxes.length) list.append(worded("p", "agent-sandbox.empty", "subtle"));
  else for (const sandbox of data.sandboxes) list.append(sandboxRow(sandbox));

  section.replaceChildren(
    worded("h2", "settings.card.agent-sandbox"), worded("p", "agent-sandbox.lead", "subtle"),
    labelFor("agent-sandbox-name", "field.agent-sandbox-name"), nameInput,
    labelFor("agent-sandbox-network", "field.agent-sandbox-network"), networkControl,
    labelFor("agent-sandbox-providers", "field.agent-sandbox-providers"), providersInput,
    create, status, list,
  );
  create.addEventListener("click", () => void createSandbox());
}

let last = null;
async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { last = await api(""); draw(last); } catch { /* signed out or offline: the next look tries again */ }
}

// Signing in shows the workspace a moment before the key is kept, so wait a little for the key.
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("agent-sandbox-card")) void refresh(); });
document.addEventListener("branch-language", () => { if (last) draw(last); });
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchAgentSandbox = { refresh };
