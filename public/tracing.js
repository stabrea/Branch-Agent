// Settings → When to check with me: the rules read as sentences, adding and removing one, and
// trying a decision out before saving it. Usage → Health: the running totals, read from this
// computer's own counters. Nothing here sends anything anywhere unless the owner turns that on.
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

const say = (message) => { const box = $("rules-status"); if (box) box.textContent = message; };

/** Every rule as one sentence, with a button to take it away again. */
function renderRules(rules) {
  const box = $("rules-list");
  if (!box) return;
  box.replaceChildren();
  for (const entry of rules) {
    const row = el("li");
    row.append(el("span", entry.sentence));
    const remove = el("button", "Remove", "danger");
    remove.type = "button";
    remove.addEventListener("click", () => void removeRule(entry.index));
    row.append(remove);
    box.append(row);
  }
  const empty = $("rules-empty");
  if (empty) empty.hidden = rules.length > 0;
}

async function loadRules() {
  try { renderRules((await api("rules")).rules); } catch (e) { say(e.message); }
}

async function removeRule(index) {
  try { renderRules((await api("rules/remove", { index })).rules); say("Removed."); } catch (e) { say(e.message); }
}

/** The form: a tool, what it is about, and what should happen. */
async function addRule() {
  const tool = $("rules-tool").value.trim() || "*";
  const kind = $("rules-kind").value;
  const pattern = $("rules-pattern").value.trim();
  const rule = { tool, decision: $("rules-decision").value, remember: "always" };
  if (pattern && kind !== "any") rule.resource = { kind, pattern };
  else if (pattern) rule.match = pattern;
  try {
    renderRules((await api("rules/add", rule)).rules);
    $("rules-pattern").value = "";
    say("Saved. It takes effect on the next thing Branch tries to do.");
  } catch (e) { say(e.message); }
}

/** Try a decision out without saving anything: what would happen, and which rule says so. */
async function testDecision() {
  const words = { allow: "It would go ahead.", ask: "It would check with you first.", deny: "It would not be allowed." };
  try {
    const answer = await api("rules/test", { tool: $("rules-test-tool").value.trim(), target: $("rules-test-target").value.trim() });
    $("rules-test-answer").textContent = `${words[answer.decision]} ${answer.because}`;
  } catch (e) { $("rules-test-answer").textContent = e.message; }
}

/** The running totals, read from the counters page and shown as a short list. */
export async function renderHealth(view) {
  let text = "";
  try {
    const response = await fetch("/api/metrics", { headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") } });
    if (!response.ok) return;
    text = await response.text();
  } catch { return; }
  const values = {};
  for (const row of text.split("\n")) {
    if (!row || row.startsWith("#")) continue;
    const at = row.lastIndexOf(" ");
    if (at > 0) values[row.slice(0, at).trim()] = Number(row.slice(at + 1));
  }
  const card = el("article", undefined, "export-card");
  card.append(el("h2", "Health"));
  card.append(el("p", "How this copy of Branch is doing right now. These numbers are counted here and stay here.", "subtle"));
  const list = el("ul", undefined, "check-list");
  for (const [name, label] of [
    ["branch_runs_running", "Tasks working right now"],
    ["branch_runs_waiting", "Tasks waiting for your answer"],
    ["branch_runs_total", "Tasks all together"],
    ["branch_runs_failed_total", "Tasks that ended badly"],
    ["branch_tool_calls_total", "Tools used"],
    ["branch_tool_failures_total", "Tools that failed"],
    ["branch_compactions_total", "Conversations shortened to make room"],
    ["branch_spans_total", "Steps recorded"],
  ]) if (values[name] !== undefined) list.append(el("li", `${label}: ${values[name]}`));
  const average = values.branch_tool_duration_seconds_count
    ? values.branch_tool_duration_seconds_sum / values.branch_tool_duration_seconds_count
    : null;
  if (average !== null) list.append(el("li", `A tool takes about ${average.toFixed(1)} seconds on average`));
  card.append(list);
  view.append(card);
}

/** Called after every state refresh of the settings screen. */
export async function render() {
  if (!$("rules-list") || !sessionStorage.getItem("branch-token")) return;
  await loadRules();
}

if ($("rules-add")) $("rules-add").addEventListener("click", () => void addRule());
if ($("rules-test-run")) $("rules-test-run").addEventListener("click", () => void testDecision());
window.branchRules = { render, renderHealth };
