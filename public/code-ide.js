/**
 * Settings → Developer → "Help with code". Two switches and two small lists: the language servers
 * and the debuggers already installed on this computer. Nothing is ever downloaded, nothing starts
 * until a switch is on, and a program that is not really there is refused when you save.
 */
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

/** One line per program: a short name, the full address of the program, and what it handles. */
function readRows(id, extra) {
  return $(id).value.split("\n").map((line) => line.trim()).filter(Boolean).reduce((out, line) => {
    const [name, path, rest] = line.split("|").map((part) => (part || "").trim());
    if (name && path) out[name] = { path, args: [], ...(extra ? extra(rest) : {}) };
    return out;
  }, {});
}
const writeRows = (rows, extra) =>
  Object.entries(rows || {}).map(([name, entry]) => `${name} | ${entry.path}${extra ? ` | ${extra(entry)}` : ""}`).join("\n");

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
    const debuggers = await call("debug-adapters");
    $("dbg-enabled").checked = !!debuggers.enabled;
    $("dbg-list").value = writeRows(debuggers.adapters);
  } catch (error) {
    status("code-ide-status", error.message);
  }
}

async function save() {
  try {
    await call("language-servers", {
      enabled: $("ls-enabled").checked,
      servers: readRows("ls-list", (rest) => ({ languages: (rest || "TypeScript").split(",").map((part) => part.trim()).filter(Boolean) })),
    });
    await call("debug-adapters", { enabled: $("dbg-enabled").checked, adapters: readRows("dbg-list") });
    status("code-ide-status", "Saved.");
  } catch (error) {
    status("code-ide-status", error.message);
  }
}

$("code-ide-save")?.addEventListener("click", save);
void loadCodeIde();
