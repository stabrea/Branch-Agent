/* Wave mac3 (commands): typed commands on the dashboard. A small line under the dashboard takes the
   commands the shared table gives this page (/status, /stop, /usage, /lockdown, /health, /go …).
   Each one goes to /api/commands/run with this tab's key, so a key that may only look can only ask
   the questions that look; anything that would open a place opens it in the app window. The line is
   shown only while the owner's switch for the shared commands is on or "when needed". */
import { card, make, say, worded } from "/dashboard/sections.js";

const $ = (id) => document.getElementById(id);
const key = () => { try { return sessionStorage.getItem("branch-token") || ""; } catch { return ""; } };
async function call(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || say("dashboard.failed", "That did not work."));
  return data;
}
/** A key that may only look cannot send, so a command that only looks is asked for with GET. */
async function run(line) {
  try {
    return await call("commands/run", { surface: "dashboard", line });
  } catch (error) {
    if (!/only look/i.test(error.message)) throw error;
    return call(`commands/run?${new URLSearchParams({ surface: "dashboard", line })}`);
  }
}

function build(list) {
  const box = card("db-commands-card", ["commands.dashboard.title", "Commands"],
    ["commands.dashboard.purpose", "Type a command such as /status, /stop or /usage. /help lists what this page understands."]);
  const form = make("form", "db-input-row");
  const label = worded("label", "sr-only", "commands.dashboard.label", "Command");
  label.htmlFor = "db-command";
  const input = make("input");
  input.id = "db-command";
  input.autocomplete = "off";
  input.placeholder = "/status";
  input.setAttribute("list", "db-command-names");
  const names = make("datalist");
  names.id = "db-command-names";
  for (const entry of list.commands.filter((row) => row.listed)) {
    const option = make("option");
    option.value = `/${entry.name}`;
    names.append(option);
  }
  const go = worded("button", "", "commands.dashboard.run", "Run");
  go.type = "submit";
  const answer = make("pre", "db-command-answer");
  answer.id = "db-command-answer";
  answer.setAttribute("role", "status");
  form.append(label, input, names, go);
  form.addEventListener("submit", (event) => { event.preventDefault(); void submit(input, answer); });
  box.append(form, answer);
  return box;
}
async function submit(input, answer) {
  const line = input.value.trim();
  if (!line) return;
  try {
    const outcome = await run(line.startsWith("/") ? line : `/${line}`);
    if (!outcome.handled) { answer.textContent = say("commands.dashboard.unknown", "This page does not know that command. Send /help for the list."); return; }
    answer.textContent = outcome.text;
    if (outcome.client?.do === "go" && !outcome.refused) location.assign(`/#open=${encodeURIComponent(outcome.client.home)}`);
    input.value = "";
  } catch (error) { answer.textContent = error.message; }
}

async function mount() {
  const area = $("db-commands");
  if (!area || area.dataset.ready) return;
  let list;
  try { list = await call("commands?surface=dashboard"); } catch { return; }
  if (list.mode === "off") return;
  area.dataset.ready = "1";
  area.append(build(list));
  area.hidden = false;
}
/* The line belongs with the dashboard itself, so it waits until the dashboard is showing. */
const grid = $("db-grid");
if (grid) {
  if (!grid.hidden) void mount();
  new MutationObserver(() => { if (!grid.hidden) void mount(); }).observe(grid, { attributes: true, attributeFilter: ["hidden"] });
}
