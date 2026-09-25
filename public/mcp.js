import { t } from "./i18n.js";
// Settings → Sharing with other AI tools: the switch, the list of tools that may be shared,
// and the ready-to-paste settings the other tool needs.
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};

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

let sharing = { enabled: false, exposedTools: [], tools: [] };
let busy = false;
/* The rows last drawn. Every state refresh asks again, and rebuilding a couple of hundred unchanged rows each
   time kept the page busy for nothing (and made tests/language-idempotent flaky on a slow machine). */
let drawn = "";

function status(message) {
  $("mcp-status").textContent = message;
}

/** One row per tool: its name, what it does, and a warning when it can change things. */
function renderTools() {
  const box = $("mcp-tools");
  $("mcp-choose").hidden = !sharing.enabled;
  const rows = JSON.stringify([sharing.exposedTools, sharing.tools]);
  if (rows === drawn && box.childElementCount === sharing.tools.length) return;
  drawn = rows;
  box.replaceChildren();
  for (const tool of sharing.tools) {
    const row = el("label", undefined, "check");
    row.title = tool.description;
    const input = el("input");
    input.type = "checkbox";
    input.checked = sharing.exposedTools.includes(tool.name);
    input.addEventListener("change", () => void chooseTool(tool.name, input.checked));
    row.append(input, el("span", tool.name));
    if (tool.changesThings) row.append(el("span", "can change things", "badge failed"));
    box.append(row);
  }
}

function summary() {
  if (!sharing.enabled) return "Off. Other AI tools cannot reach Branch.";
  const count = sharing.exposedTools.length;
  return count
    ? `On. Other tools can ask Branch to do things, and may use ${count} of its own tools.`
    : "On. Other tools can ask Branch to do things, but may not use any of its own tools.";
}

async function save(next) {
  if (busy) return;
  busy = true;
  try {
    sharing = await api("mcp/settings", next);
    $("mcp-enabled").checked = sharing.enabled;
    renderTools();
    status(summary());
  } catch (e) {
    status(e.message);
  } finally {
    busy = false;
  }
}

function chooseTool(name, chosen) {
  const exposedTools = sharing.exposedTools.filter((tool) => tool !== name);
  if (chosen) exposedTools.push(name);
  return save({ enabled: sharing.enabled, exposedTools });
}

/** Switching on for the first time offers the tools that only read; the rest stay unticked. */
async function switchSharing(enabled) {
  try {
    if (!sharing.tools.length) sharing = await api("mcp/settings");
    const readOnly = sharing.tools.filter((tool) => !tool.changesThings).map((tool) => tool.name);
    const exposedTools = enabled && !sharing.exposedTools.length ? readOnly : sharing.exposedTools;
    await save({ enabled, exposedTools });
  } catch (e) {
    status(e.message);
  }
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t("mcp.copied");
  } catch {
    button.textContent = t("mcp.copyHint");
  }
  setTimeout(() => { button.textContent = original; }, 2500);
}

/** The page never shows the session key itself; Copy puts the real value on the clipboard. */
function snippet(name, entry, secret) {
  const item = el("div", undefined, "item");
  const shown = secret ? entry.configExample.split(secret).join("YOUR_SESSION_KEY") : entry.configExample;
  item.append(el("h3", name), el("p", entry.note, "subtle"), el("pre", shown));
  const copy = el("button", t("mcp.copy"));
  copy.type = "button";
  copy.addEventListener("click", () => void copyText(entry.configExample, copy));
  item.append(copy);
  return item;
}

function renderConnection(connection) {
  const box = $("mcp-connection");
  box.replaceChildren();
  box.append(el("p", connection.stdio.packaged
    ? "Claude Desktop starts its own copy of Branch in the background, using the app installed on this computer and your existing records."
    : `Claude Desktop starts its own copy of Branch by running "${connection.stdio.command} ${connection.stdio.args.join(" ")}", which needs Branch installed as a command.`,
    "subtle"));
  box.append(snippet("Claude Desktop", connection.claudeDesktop, connection.bearerToken));
  box.append(snippet("Claude Code", connection.claudeCode, connection.bearerToken));
  box.append(snippet("Cursor", connection.cursor, connection.bearerToken));
  box.append(el("p", "Claude Code and Cursor talk to Branch over this computer's own address, so Branch has to be open. The key in those settings is private: anyone who has it can use Branch.", "subtle"));
}

/** Called after every state refresh; loads what is shared and how to connect. */
async function render() {
  try {
    sharing = await api("mcp/settings");
    $("mcp-enabled").checked = sharing.enabled;
    renderTools();
    status(summary());
    renderConnection(await api("mcp/connection"));
  } catch (e) {
    status(e.message);
  }
}

$("mcp-enabled").addEventListener("change", (event) => void switchSharing(event.target.checked));
window.branchMcp = { render };
