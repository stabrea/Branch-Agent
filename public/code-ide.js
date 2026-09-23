/**
 * Settings → Developer → "Help with code". Two switches and two small lists: the language servers
 * and the debuggers already installed on this computer. Nothing is ever downloaded, nothing starts
 * until a switch is on, and a program that is not really there is refused when you save.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";

async function call(path, body) {
  const response = await fetch(`/api/developer/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work.");
  return data;
}

/** The words that go after the program's address, the way a code editor would put them there. */
const readArgs = (text) => (text || "").split(/\s+/).map((part) => part.trim()).filter(Boolean);

/** One line per program: a short name, the full address, whatever goes after it, then extras. */
function readRows(id, extra) {
  return $(id).value.split("\n").map((line) => line.trim()).filter(Boolean).reduce((out, line) => {
    const [name, path, args, rest] = line.split("|").map((part) => (part || "").trim());
    if (name && path) out[name] = { path, args: readArgs(args), ...(extra ? extra(rest) : {}) };
    return out;
  }, {});
}
const writeRows = (rows, extra) =>
  Object.entries(rows || {})
    .map(([name, entry]) => [name, entry.path, (entry.args || []).join(" "), ...(extra ? [extra(entry)] : [])].join(" | "))
    .join("\n");

function status(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

export async function loadCodeIde() {
  if (!$("ls-enabled")) return;
  try {
    const servers = await call("language-servers");
    $("ls-enabled").checked = !!servers.enabled;
    $("ls-list").value = writeRows(servers.servers, (entry) => (entry.languages || []).join(", "));
    $("ls-keep").checked = !!servers.keepRunning;
    const debuggers = await call("debug-adapters");
    $("dbg-enabled").checked = !!debuggers.enabled;
    $("dbg-list").value = writeRows(debuggers.adapters);
    $("dbg-keep").checked = !!debuggers.keepRunning;
  } catch (error) {
    status("code-ide-status", error.message);
  }
}

async function save() {
  try {
    await call("language-servers", {
      enabled: $("ls-enabled").checked,
      keepRunning: $("ls-keep").checked,
      servers: readRows("ls-list", (rest) => ({ languages: (rest || "TypeScript").split(",").map((part) => part.trim()).filter(Boolean) })),
    });
    await call("debug-adapters", { enabled: $("dbg-enabled").checked, keepRunning: $("dbg-keep").checked, adapters: readRows("dbg-list") });
    status("code-ide-status", "Saved.");
  } catch (error) {
    status("code-ide-status", error.message);
  }
}

$("code-ide-save")?.addEventListener("click", save);
// Nothing is asked for until the section is opened, so a page nobody has signed in on stays quiet.
let loaded = false;
$("code-ide")?.addEventListener("toggle", () => {
  if (!loaded && $("code-ide").open) { loaded = true; void loadCodeIde(); }
});

// bucket-18 (A0300): the three-way switch for pull requests opened from a task's changes.
async function loadPullRequests() {
  try {
    const settings = await call("pull-requests");
    $("pull-requests-mode").value = settings.mode || "off";
  } catch (error) {
    status("pull-requests-status", error.message);
  }
}
/* DG-025: one choice, saved the moment it changes, as the approved sample does; a failed save says so. */
$("pull-requests-mode")?.addEventListener("change", async () => {
  try {
    await call("pull-requests", { mode: $("pull-requests-mode").value });
    status("pull-requests-status", t("developer.pull-requests.saved"));
  } catch (error) {
    status("pull-requests-status", error.message);
  }
});
let pullRequestsLoaded = false;
$("pull-requests")?.addEventListener("toggle", () => {
  if (!pullRequestsLoaded && $("pull-requests").open) { pullRequestsLoaded = true; void loadPullRequests(); }
});
