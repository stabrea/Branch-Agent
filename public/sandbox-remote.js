import { t } from "./i18n.js";
// Settings → Approvals: where scripts run, what can reach out, how much one person may ask for, and
// how long conversations are kept. Plus the Remote computers card. Everything here reads a module
// that already decided; nothing on these screens decides anything itself.
const $ = (id) => document.getElementById(id);

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

const say = (id, message) => { const node = $(id); if (node) node.textContent = message; };
const list = (id) => { const node = $(id); if (node) node.replaceChildren(); return node; };
function line(text, className = "") {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ where scripts run */

async function showSandboxes() {
  const { settings, backends } = await api("sandboxes");
  $("sandbox-image").value = settings.image ?? "";
  $("sandbox-distro").value = settings.distro ?? "";
  $("sandbox-windows").checked = Boolean(settings.windowsSandbox);
  const where = list("sandbox-backends");
  for (const backend of backends) {
    const row = document.createElement("div");
    row.className = "card-row";
    /* DG-024: a place a script can run is a line of the card, not a heading. */
    const title = document.createElement("p");
    title.append(document.createElement("b"));
    title.firstChild.textContent = backend.available ? t("sandboxRemote.runs", { what: backend.runs }) : t("sandboxRemote.notHere", { what: backend.runs });
    row.append(title, line(backend.protects, "subtle"));
    if (!backend.available) row.append(line(backend.reason, "subtle"));
    where.append(row);
  }
}

/* ------------------------------------------------------------------ what can reach out */

async function showFirewall() {
  const view = await api("firewall");
  const where = list("firewall-sentences");
  for (const sentence of view.sentences) where.append(line(sentence));
  say("firewall-status", view.limited ? "" : "Nothing is limited at the moment.");
}

async function testAddress() {
  try {
    const answer = await api("firewall/test", { address: $("firewall-address").value.trim() });
    say("firewall-status", answer.reason);
  } catch (error) { say("firewall-status", error.message); }
}

/* ------------------------------------------------------------------ ceilings */

const limitFields = ["requestsPerMinute", "tokensPerHour", "senderRequestsPerMinute", "senderTokensPerHour"];
const limitIds = { requestsPerMinute: "limit-requests", tokensPerHour: "limit-tokens",
  senderRequestsPerMinute: "limit-sender-requests", senderTokensPerHour: "limit-sender-tokens" };

async function showLimits() {
  const { limits } = await api("limits");
  // A box the person is already typing in is left alone: this answer can arrive after they started.
  for (const field of limitFields) if (document.activeElement !== $(limitIds[field])) $(limitIds[field]).value = limits[field] ?? 0;
}
async function saveLimits() {
  try {
    const body = {};
    for (const field of limitFields) body[field] = Math.max(0, Number($(limitIds[field]).value) || 0);
    await api("limits", body);
    say("limit-status", "Saved. Your own tasks wait; anybody messaging from outside is told in one sentence.");
  } catch (error) { say("limit-status", error.message); }
}

/* ------------------------------------------------------------------ other computers */

async function showRemotes() {
  const { computers } = await api("remotes");
  const where = list("remote-list");
  if (!computers.length) where.append(line("No other computers yet.", "subtle"));
  for (const computer of computers) {
    const row = document.createElement("div");
    row.className = "card-row";
    const title = document.createElement("h4");
    title.textContent = computer.label || computer.alias;
    const programs = computer.executables.length
      ? `It may run: ${computer.executables.join(", ")}.`
      : "It may hold files and run nothing at all.";
    const drop = document.createElement("button");
    drop.type = "button";
    drop.textContent = t("sandboxRemote.action.remove");
    drop.addEventListener("click", () => void removeRemote(computer.alias));
    row.append(title, line(`${computer.alias}, working in ${computer.root}. ${programs}`, "subtle"), drop);
    where.append(row);
  }
}

async function addRemote() {
  try {
    const programs = $("remote-programs").value.split(",").map((name) => name.trim()).filter(Boolean);
    await api("remotes", {
      alias: $("remote-alias").value.trim(), root: $("remote-root").value.trim(),
      label: $("remote-label").value.trim(), executables: programs,
    });
    await showRemotes();
    say("remote-status", "Added.");
  } catch (error) { say("remote-status", error.message); }
}
async function removeRemote(computer) {
  try {
    await api("remotes/remove", { computer });
    await showRemotes();
    say("remote-status", "Taken off.");
  } catch (error) { say("remote-status", error.message); }
}

/* ------------------------------------------------------------------ how long conversations are kept */

function showProposal(answer) {
  say("retention-sentence", answer.sentence ?? "");
  const where = list("retention-proposal");
  const found = answer.conversations ?? [];
  $("retention-prune").hidden = found.length === 0;
  if (!found.length) { where.append(line("Nothing would be deleted today.", "subtle")); return; }
  where.append(line(`${found.length} conversation(s) would be offered for deletion.`));
  for (const entry of found.slice(0, 20))
    where.append(line(`Started ${entry.createdAt.slice(0, 10)}, ${entry.messageCount} message(s) — ${entry.why}.`, "subtle"));
}

async function showRetention() {
  const answer = await api("retention");
  $("retention-enabled").checked = Boolean(answer.settings.enabled);
  $("retention-days").value = answer.settings.keepDays ?? 0;
  $("retention-mb").value = answer.settings.megabytes ?? 0;
  $("retention-export").checked = answer.settings.exportBeforeDeleting !== false;
  showProposal(answer);
}

async function saveRetention() {
  try {
    showProposal(await api("retention", {
      enabled: $("retention-enabled").checked,
      keepDays: Math.max(0, Number($("retention-days").value) || 0),
      megabytes: Math.max(0, Number($("retention-mb").value) || 0),
      exportBeforeDeleting: $("retention-export").checked,
    }));
    say("retention-status", "Saved. Nothing is deleted until you say so.");
  } catch (error) { say("retention-status", error.message); }
}

async function prune() {
  if (!window.confirm(t("sandboxRemote.confirm.delete"))) return;
  try {
    const done = await api("retention/prune", { approve: true });
    say("retention-status", `${done.removed.length} conversation(s) deleted; ${done.exported.length} saved copy/copies handed back.`);
    await showRetention();
  } catch (error) { say("retention-status", error.message); }
}

/* ------------------------------------------------------------------ the screens together */

async function render() {
  for (const [what, show] of [["sandbox-backends", showSandboxes], ["firewall-sentences", showFirewall],
    ["limit-requests", showLimits], ["remote-list", showRemotes], ["retention-proposal", showRetention]])
    if ($(what)) await show().catch((error) => say("firewall-status", error.message));
}

async function saveSandboxes() {
  try {
    await api("sandboxes", { image: $("sandbox-image").value.trim() || "node:22-alpine",
      distro: $("sandbox-distro").value.trim(), windowsSandbox: $("sandbox-windows").checked });
    await showSandboxes();
    say("sandbox-status", "Saved.");
  } catch (error) { say("sandbox-status", error.message); }
}

/* DG-025: saved as you go, as in the sample: the switch when it flips, a name when you leave its box. */
for (const id of ["sandbox-image", "sandbox-distro", "sandbox-windows"]) $(id)?.addEventListener("change", () => void saveSandboxes());
$("firewall-test")?.addEventListener("click", () => void testAddress());
// DG-025: saved as you go, as the sample saves a number: when the box is left or Enter is pressed.
for (const id of Object.values(limitIds)) $(id)?.addEventListener("change", () => void saveLimits());
$("remote-add")?.addEventListener("click", () => void addRemote());
$("retention-save")?.addEventListener("click", () => void saveRetention());
$("retention-prune")?.addEventListener("click", () => void prune());

window.branchSandboxRemote = { render };
