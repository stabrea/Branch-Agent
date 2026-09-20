// Settings → Sharing with other AI tools, second half: what Branch is holding back from a
// connected tool and why, how long connections to other people's servers stay open, and a bench
// for trying a server out before keeping it.
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
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}

/** What is on offer to a connected tool, and what your settings hold back. */
async function renderPreflight() {
  const box = $("mcp-preflight");
  if (!box) return;
  const result = await api("mcp/preflight");
  box.replaceChildren();
  if (!result.hidden.length && !result.allowed.length) {
    box.append(el("p", "You are not sharing any of Branch's own tools yet, so there is nothing to hold back.", "subtle"));
    return;
  }
  for (const entry of [...result.hidden, ...result.allowed]) {
    const row = el("div", undefined, "item");
    row.append(el("strong", entry.name), el("p", entry.reason, "subtle"));
    box.append(row);
  }
}

/**
 * ci-flakes-4: this card is drawn again by the window's refresh every 3 seconds. What somebody is in
 * the middle of typing or choosing must survive that, so the saved answer is written in only while what
 * is on screen is still what this file last wrote. Otherwise their minutes were replaced within three
 * seconds and Save sent the old number back. (The same guard as public/os-permissions.js.)
 */
const lastWritten = new Map();
function showSaved(id, value) {
  const box = $(id);
  if (!box) return;
  if (lastWritten.has(id) && box.value !== lastWritten.get(id)) return; // their own unsaved answer
  box.value = value;
  lastWritten.set(id, box.value);
}
/** Once an answer is saved it is the one on screen, so the next refresh may write over it again. */
const savedByHand = (id) => { if ($(id)) lastWritten.set(id, $(id).value); };

/** How long a connection to somebody else's server stays open, and how each one is faring. */
async function renderConnections() {
  const box = $("mcp-health");
  if (!box) return;
  const state = await api("mcp/connections");
  showSaved("mcp-keep-warm", String(state.settings.keepWarmMinutes));
  showSaved("mcp-max-servers", String(state.settings.maxConcurrentServers));
  if ($("mcp-connect-when")) showSaved("mcp-connect-when", state.settings.connect);
  box.replaceChildren();
  if (!state.servers.length) {
    box.append(el("p", "Nothing to show. No server you set up in the connections file has been started in this launch.", "subtle"));
    return;
  }
  for (const server of state.servers) {
    const row = el("div", undefined, "item");
    row.append(el("strong", server.id), el("p", server.summary, "subtle"));
    box.append(row);
  }
}

async function saveConnections() {
  try {
    await api("mcp/connections", {
      keepWarmMinutes: Number($("mcp-keep-warm").value),
      maxConcurrentServers: Number($("mcp-max-servers").value),
      ...($("mcp-connect-when") ? { connect: $("mcp-connect-when").value } : {}),
    });
    for (const id of ["mcp-keep-warm", "mcp-max-servers", "mcp-connect-when"]) savedByHand(id);
    $("mcp-try-status").textContent = "Saved.";
    await renderConnections();
  } catch (error) {
    $("mcp-try-status").textContent = error.message;
  }
}

/** What the owner typed into the "try a server" boxes, as the shape the route expects. */
function serverFromForm() {
  const address = $("mcp-try-url").value.trim();
  if (!address) throw new Error("Give a web address, or the command that starts the server.");
  if (/^https?:\/\//i.test(address)) return { transport: "http", url: address };
  const parts = address.split(/\s+/);
  return { transport: "stdio", command: parts[0], args: parts.slice(1) };
}

let offered = [];

async function tryServer() {
  const status = $("mcp-try-status");
  status.textContent = "Asking that server what it offers…";
  try {
    const result = await api("mcp/try", { server: serverFromForm() });
    offered = result.tools;
    status.textContent = `${result.serverName} version ${result.serverVersion} offers ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}.`;
    const picker = $("mcp-try-tool");
    picker.replaceChildren(...result.tools.map((tool) => {
      const option = el("option", tool.name);
      option.value = tool.name;
      option.title = tool.description;
      return option;
    }));
    $("mcp-try-run-row").hidden = result.tools.length === 0;
    drawForm();
  } catch (error) {
    status.textContent = error.message;
    $("mcp-try-run-row").hidden = true;
  }
}

/** A box per thing the chosen tool asks for, built from the shape that server described. */
function drawForm() {
  const box = $("mcp-try-form");
  box.replaceChildren();
  const tool = offered.find((entry) => entry.name === $("mcp-try-tool").value);
  const properties = (tool && tool.schema && tool.schema.properties) || {};
  const required = new Set((tool && tool.schema && tool.schema.required) || []);
  for (const [name, shape] of Object.entries(properties)) {
    const label = el("label", `${name}${required.has(name) ? " (needed)" : ""}`);
    label.htmlFor = `mcp-arg-${name}`;
    const input = el("input");
    input.id = `mcp-arg-${name}`;
    input.type = shape && shape.type === "number" ? "number" : "text";
    input.dataset.argument = name;
    input.dataset.kind = (shape && shape.type) || "string";
    input.placeholder = (shape && shape.description) || "";
    box.append(label, input);
  }
}

function argumentsFromForm() {
  const values = {};
  for (const input of $("mcp-try-form").querySelectorAll("input[data-argument]")) {
    if (!input.value) continue;
    values[input.dataset.argument] = input.dataset.kind === "number" ? Number(input.value) : input.value;
  }
  return values;
}

async function callTool() {
  const status = $("mcp-try-status");
  status.textContent = "Running that tool…";
  try {
    const result = await api("mcp/try", {
      server: serverFromForm(),
      call: { name: $("mcp-try-tool").value, arguments: argumentsFromForm() },
    });
    status.textContent = `Answered in ${result.called.milliseconds} milliseconds. Written down in Activity.`;
    $("mcp-try-result").textContent = JSON.stringify(result.called.result, null, 2);
    $("mcp-try-result").hidden = false;
  } catch (error) {
    status.textContent = error.message;
    $("mcp-try-result").hidden = true;
  }
}

async function render() {
  try {
    await renderPreflight();
    await renderConnections();
  } catch (error) {
    $("mcp-try-status").textContent = error.message;
  }
}

$("mcp-try-go")?.addEventListener("click", () => void tryServer());
$("mcp-try-call")?.addEventListener("click", () => void callTool());
$("mcp-try-tool")?.addEventListener("change", drawForm);
$("mcp-connections-save")?.addEventListener("click", () => void saveConnections());
window.branchMcpWorkbench = { render };
