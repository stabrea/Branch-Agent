// Settings → When to check with me: which approval preset is in force, how fast one conversation
// may work, and any question a task has stopped on waiting for a yes.
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

let state = { policy: { preset: "off", rules: [], limits: {} }, presets: [], waiting: [] };
const status = (message) => { $("policy-status").textContent = message; };

/** The list of presets to choose from, with the plain-language description of each. */
function renderPresets() {
  const picker = $("policy-preset");
  picker.replaceChildren();
  for (const preset of state.presets) picker.append(new Option(preset.label, preset.id));
  if (state.policy.preset === "custom") picker.append(new Option("Rules I set myself", "custom"));
  picker.value = state.policy.preset;
  const chosen = state.presets.find((preset) => preset.id === state.policy.preset);
  $("policy-description").textContent = chosen
    ? chosen.description
    : "Your own rules are in force. Pick a starting point above to replace them.";
}

/** One line per rule, so the owner can see exactly what is allowed, asked about or refused. */
function renderRules() {
  const box = $("policy-rules");
  box.replaceChildren();
  const words = { allow: "goes ahead", ask: "checks with you", deny: "is not allowed" };
  for (const rule of state.policy.rules) {
    const what = rule.tool === "*" ? (rule.applies === "changes" ? "Anything that changes something" : "Anything") : rule.tool;
    const where = rule.match === "*" ? "" : ` on ${rule.match}`;
    box.append(el("li", `${what}${where} ${words[rule.decision]}.`));
  }
  $("policy-rules-empty").hidden = state.policy.rules.length > 0;
}

/** A task that has stopped and is waiting to be told whether to go ahead. */
function renderWaiting() {
  const box = $("policy-waiting");
  box.replaceChildren();
  $("policy-waiting-card").hidden = state.waiting.length === 0;
  for (const question of state.waiting) {
    const item = el("div", undefined, "item");
    item.append(el("h3", question.label), el("p", question.question, "subtle"));
    // Exactly what it wants to do, word for word, with any saved password or key already taken out.
    // Your answer is tied to these exact words: if it changes them, it has to ask again.
    if (question.bytes) item.append(el("pre", question.bytes, "subtle"));
    if (question.remember === "session")
      item.append(el("p", "A yes for this conversation lasts until you close it, or until you lock Branch.", "subtle"));
    for (const [label, remember] of [["Yes, just now", "never"], ["Yes, for this conversation", "session"], ["Yes, always", "always"]]) {
      if (remember === "always" && question.source !== "owner") continue;
      const button = el("button", label);
      button.type = "button";
      button.addEventListener("click", () => void answer(question.sessionId, "allow", remember, question.fingerprint));
      item.append(button);
    }
    const no = el("button", "No", "danger");
    no.type = "button";
    no.addEventListener("click", () => void answer(question.sessionId, "deny", "session", question.fingerprint));
    item.append(no);
    box.append(item);
  }
}

async function answer(sessionId, decision, remember, fingerprint) {
  try {
    await api("policy/approve", { sessionId, decision, remember, ...(fingerprint ? { fingerprint } : {}) });
    status(decision === "allow" ? "Noted. Send your next message in that conversation to carry on." : "Noted. It will not do that.");
    await render();
  } catch (e) {
    status(e.message);
  }
}

async function save(next) {
  try {
    state.policy = (await api("policy", next)).policy;
    renderPresets();
    renderRules();
    status("Saved.");
  } catch (e) {
    status(e.message);
  }
}

function saveLimits() {
  const number = (id) => Math.max(0, Math.min(1000, Number($(id).value) || 0));
  return save({ limits: { toolCallsPerMinute: number("policy-tool-limit"), modelRoundsPerMinute: number("policy-round-limit") } });
}

/** Called after every state refresh. */
async function render() {
  try {
    state = await api("policy");
    $("policy-tool-limit").value = state.policy.limits.toolCallsPerMinute ?? 0;
    $("policy-round-limit").value = state.policy.limits.modelRoundsPerMinute ?? 0;
    renderPresets();
    renderRules();
    renderWaiting();
  } catch (e) {
    status(e.message);
  }
}

$("policy-preset").addEventListener("change", (event) => void save({ preset: event.target.value }));
$("policy-limits-save").addEventListener("click", () => void saveLimits());
window.branchApprovals = { render };
