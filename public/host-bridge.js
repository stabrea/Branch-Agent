// Settings → Your other computers → "Run something on one computer" (FQ-execution.host-bridge).
// The owner names a computer explicitly, from the ones already added, and the answer that comes back
// always carries which computer it came from, right beside what it said.
import { t } from "./i18n.js";
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

/** The computer picker mirrors the "Your other computers" list; nothing here can add or remove one. */
async function showComputers() {
  const select = $("host-bridge-computer");
  if (!select) return;
  const chosen = select.value;
  const { computers } = await api("remotes");
  select.replaceChildren();
  if (!computers.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("host-bridge.add-computer");
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const computer of computers) {
    const option = document.createElement("option");
    option.value = computer.alias;
    option.textContent = computer.label || computer.alias;
    select.append(option);
  }
  if (computers.some((computer) => computer.alias === chosen)) select.value = chosen;
}

/** The question the owner's approval settings put first, with the one button that answers yes. */
function showQuestion(where, question, body) {
  const row = document.createElement("div");
  row.className = "card-row";
  const text = document.createElement("p");
  text.textContent = question;
  const yes = document.createElement("button");
  yes.type = "button";
  yes.id = "host-bridge-confirm";
  yes.textContent = t("host-bridge.confirm");
  yes.addEventListener("click", () => void send({ ...body, confirm: true }));
  row.append(text, yes);
  where.append(row);
  say("host-bridge-status", "Waiting for your yes.");
}

async function send(body) {
  say("host-bridge-status", "Running…");
  const where = list("host-bridge-result");
  try {
    // The same gate as "Try a tool": Lockdown and your own rules can refuse it, or ask first.
    const result = await api("host-bridge/run", body);
    if (result.status === "asked") { showQuestion(where, result.question, body); return; }
    // The row that comes back names the computer it was sent to, explicitly, before the answer
    // itself — so a reply is never read as if it came from whichever computer was merely selected.
    const row = document.createElement("div");
    row.className = "card-row";
    const title = document.createElement("h4");
    title.textContent = t("host-bridge.ran-on", { computer: result.computer });
    const output = document.createElement("pre");
    output.textContent = result.output || "(no output)";
    row.append(title, output);
    where.append(row);
    say("host-bridge-status", `${result.computer} ran ${result.program}.`);
  } catch (error) {
    say("host-bridge-status", error.message);
  }
}

function runOnHost() {
  const computer = $("host-bridge-computer").value;
  const program = $("host-bridge-program").value.trim();
  const args = $("host-bridge-args").value.split(" ").map((part) => part.trim()).filter(Boolean);
  if (!computer) { say("host-bridge-status", "Add a computer above first."); return; }
  if (!program) { say("host-bridge-status", "Name a program to run."); return; }
  void send({ computer, program, args });
}

async function render() {
  if (!$("host-bridge-computer")) return;
  await showComputers().catch((error) => say("host-bridge-status", error.message));
}

$("host-bridge-run")?.addEventListener("click", runOnHost);

window.branchHostBridge = { render };
