// Settings → When to check with me: which approval preset is in force, how fast one conversation
// may work, and any question a task has stopped on waiting for a yes.
import { t } from "/i18n.js";

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
  // Integration review (p2-shell): the three-second refresh used to rebuild these options every time,
  // which closed an open list under the person's pointer (public/glass-select.js closes a list whose
  // choices change). The options are only rebuilt when they are really different.
  const wanted = [...state.presets.map((preset) => [preset.id, preset.label]), ...(state.policy.preset === "custom" ? [["custom", "Rules I set myself"]] : [])];
  const same = picker.options.length === wanted.length && wanted.every(([id, label], index) => picker.options[index].value === id && picker.options[index].text === label);
  if (!same) picker.replaceChildren(...wanted.map(([id, label]) => new Option(label, id)));
  if (picker.value !== state.policy.preset) picker.value = state.policy.preset;
  const chosen = state.presets.find((preset) => preset.id === state.policy.preset);
  const localDescription = chosen ? t(`policy.preset.${chosen.id}.description`) : "";
  $("policy-description").textContent = chosen
    ? (localDescription.startsWith("policy.preset.") ? chosen.description : localDescription)
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
/**
 * The three ways a rule can say a program should be held. The page may be open on another computer
 * than the one that runs the program, so it names no system; the server's own sentence does.
 */
const HELD = {
  "no-internet": "in a box the computer holds to its memory and processor limits, with no way out to the internet",
  "limits-only": "in a box the computer holds to its memory and processor limits",
  none: "with no extra box beyond what the settings already hold",
};

function renderWaiting() {
  const box = $("policy-waiting");
  box.replaceChildren();
  $("policy-waiting-card").hidden = state.waiting.length === 0;
  for (const question of state.waiting) {
    const item = el("div", undefined, "item");
    item.append(el("h3", question.label), el("p", question.question, "subtle"));
    const listed = filesBlock(question, "subtle");
    if (listed) item.append(listed);
    // Exactly what it wants to do, word for word, with any saved password or key already taken out.
    // Your answer is tied to these exact words: if it changes them, it has to ask again.
    if (question.bytes) item.append(el("pre", question.bytes, "subtle"));
    // When one of your rules says how tightly a program this would start should be held, say so
    // here, before you answer — not afterwards.
    if (question.sandbox) item.append(el("p", `Your rules say to run this ${HELD[question.sandbox] ?? question.sandbox}.`, "subtle"));
    if (question.remember === "session")
      item.append(el("p", "A yes for this conversation lasts until you close it, or until you lock Branch.", "subtle"));
    // Wave mac3 (tool-safety): a step the safety check advised against can only be allowed this once.
    if (question.onceOnly) item.append(el("p", t("live.onceOnly"), "subtle"));
    // mac7/coding-next: "Let Branch run this project's tests?" has answers of its own.
    const yeses = question.kind === "project-tests" ? [["Always for this folder", "always"], ["Once", "never"]]
      : [["Yes, just now", "never"], ["Yes, for this conversation", "session"], ["Yes, always", "always"]];
    for (const [label, remember] of yeses) {
      if (remember === "always" && question.source !== "owner") continue;
      if (question.onceOnly && remember !== "never") continue;
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

/* mac7/multi-target: every file a question's call touches, the first few named and the rest folded away. */
function filesBlock(question, tone) {
  const files = Array.isArray(question.files) ? question.files : [];
  if (files.length < 2) return null;
  const line = (file) => el("li", t(file.kind === "read" ? "live.fileRead" : file.kind === "delete" ? "live.fileDelete" : "live.fileWrite", { path: file.path }));
  const shown = el("ul");
  for (const file of files.slice(0, 5)) shown.append(line(file));
  const box = el("div");
  box.append(el("p", t("live.files", { count: files.length }), tone), shown);
  if (files.length > 5) {
    const more = el("details"), rest = el("ul");
    for (const file of files.slice(5)) rest.append(line(file));
    more.append(el("summary", t("live.filesMore", { count: files.length - 5 })), rest);
    box.append(more);
  }
  return box;
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

/** Whether it really was saved: a ceiling is only "what is on screen" again once the server took it. */
async function save(next) {
  try {
    state.policy = (await api("policy", next)).policy;
    renderPresets();
    renderRules();
    status("Saved.");
    return true;
  } catch (e) {
    status(e.message);
    return false;
  }
}

const limitBoxes = ["policy-tool-limit", "policy-round-limit"];
/**
 * ci-flakes-4: this card is drawn again by the window's refresh every 3 seconds. A ceiling somebody is
 * in the middle of typing must survive that. Marking the field dirty on its input event also covers
 * the first refresh racing the first keystroke, before this module has written an initial value.
 */
const dirtyLimits = new Set();
for (const id of limitBoxes) $(id)?.addEventListener("input", () => dirtyLimits.add(id));
function showSaved(id, value) {
  const box = $(id);
  if (!box) return;
  if (dirtyLimits.has(id)) return;
  box.value = value;
}

async function saveLimits() {
  const number = (id) => Math.max(0, Math.min(1000, Number($(id).value) || 0));
  const saved = await save({ limits: { toolCallsPerMinute: number("policy-tool-limit"), modelRoundsPerMinute: number("policy-round-limit") } });
  // Once saved, what is on screen is the saved answer again, so a refresh may write over it. A save
  // that did not land leaves the ceiling theirs, so the refresh does not take it away as well.
  if (saved) for (const id of limitBoxes) dirtyLimits.delete(id);
}

/** Called after every state refresh. */
async function render() {
  try {
    state = await api("policy");
    showSaved("policy-tool-limit", String(state.policy.limits.toolCallsPerMinute ?? 0));
    showSaved("policy-round-limit", String(state.policy.limits.modelRoundsPerMinute ?? 0));
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
