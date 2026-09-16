/**
 * Which model does what. Two things live here: the "/model" command you can type in the message
 * box to change the model for the conversation you are in, and the Settings cards that hold your
 * named profiles and check what each connection can actually do right now.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const bearer = () => "Bearer " + (sessionStorage.getItem("branch-token") || "");
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: bearer(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
/** The page gives an element the id "toast", so only a real function is ever called. */
const say = (message) => (typeof globalThis.toast === "function" ? globalThis.toast(message) : console.warn(message));
const connected = () => Boolean(sessionStorage.getItem("branch-token"));

/* ---------- "/model" in the message box ---------- */

/** What "/model" means. Nothing after it, or a question mark, means "show me the list". */
export function parseModelCommand(line) {
  const match = /^\/model(?:\s+(.*))?$/i.exec(String(line).trim());
  if (!match) return null;
  const wanted = (match[1] ?? "").trim();
  return wanted && wanted !== "?" ? { list: false, wanted } : { list: true };
}

/**
 * Handles a line typed in the message box that is a command rather than a message. Returns true
 * when it dealt with the line, so the ordinary send is skipped and nothing reaches the model.
 */
globalThis.branchSlashCommand = async function branchSlashCommand(typed, sessionId) {
  const command = parseModelCommand(typed);
  if (!command) return false;
  try {
    if (command.list) {
      const { active, choices } = await request("/api/models/switch");
      const lines = choices.map((choice) =>
        `${choice.id === active ? "→ " : "  "}${choice.name} (${choice.model})${choice.onThisComputer ? " · on this computer" : ""}${choice.resting ? " · resting after a failure" : ""}`);
      say(`Type /model followed by a name:\n${lines.join("\n")}`);
      return true;
    }
    if (!sessionId) { say("Start a conversation first, then /model changes the model for it."); return true; }
    const result = await request("/api/models/switch", { sessionId, model: command.wanted });
    say(result.message);
    await globalThis.branchRefreshSessionModel?.();
  } catch (error) { say(error.message); }
  return true;
};

/* ---------- Settings: your named profiles ---------- */

/**
 * Connection id to the name a person gave it, so the profile cards read "Work laptop → Fast one"
 * rather than a row of ids. An id with no connection left keeps its id, which is the honest answer.
 */
let presetNames = new Map();
async function loadPresetNames() {
  try {
    const { choices } = await request("/api/models/switch");
    presetNames = new Map(choices.map((choice) => [choice.id, choice.name]));
  } catch { /* the cards fall back to ids, which still say which connection is meant */ }
}
const presetName = (id) => presetNames.get(id) ?? id;

async function loadProfiles() {
  const select = $("model-profile-active");
  if (!select) return;
  try {
    await loadPresetNames();
    const settings = await request("/api/models/profiles");
    select.replaceChildren(option("", "None — use my usual choice"),
      ...settings.profiles.map((profile) => option(profile.id, profile.name)));
    select.value = settings.active ?? "";
    const list = $("model-profile-list");
    list.replaceChildren(...settings.profiles.map((profile) => {
      const card = el("div", undefined, "record");
      card.append(el("strong", profile.name), el("p", profile.description, "meta"), el("p", order(profile), "meta"));
      return card;
    }));
    await showWhy();
  } catch (error) { say(error.message); }
}
function option(value, label) {
  const node = el("option", label);
  node.value = value;
  return node;
}
function order(profile) {
  const chosen = profile.fallback;
  if (!chosen) return "Nothing is set up for this profile yet.";
  return `Tries in order: ${[chosen.preset, ...chosen.fallbacks].map(presetName).join(" → ")}`;
}

/** The one sentence that says why a model would answer the next ordinary message. */
async function showWhy() {
  const line = $("model-profile-why");
  if (!line) return;
  try {
    const { choice } = await request("/api/models/profiles/preview", { kind: "chat" });
    line.textContent = choice.reason;
  } catch (error) { line.textContent = error.message; }
}

async function saveProfiles() {
  try {
    await request("/api/models/profiles", { active: $("model-profile-active").value || null });
    say("Saved. New messages follow this profile.");
    await loadProfiles();
  } catch (error) { say(error.message); }
}

/* ---------- Settings: checking each connection ---------- */

async function probeConnections() {
  const list = $("model-probe-list");
  if (!list) return;
  list.replaceChildren(el("p", "Checking…", "meta"));
  try {
    const { connections } = await request("/api/models/probe");
    list.replaceChildren(...connections.map((connection) => {
      const card = el("div", undefined, "record");
      card.append(el("strong", `${connection.name} — ${connection.signedIn ? "working" : "needs attention"}`));
      card.append(el("p", connection.summary, "meta"));
      // What this connection can and cannot be asked to do, in the words the server sent.
      for (const line of connection.canSaid ?? []) card.append(el("p", line, "meta"));
      if (connection.fix) card.append(el("p", connection.fix, "meta"));
      return card;
    }));
  } catch (error) {
    list.replaceChildren(el("p", error.message, "meta"));
  }
}

/* ---------- Settings: signing in with Google for Gemini ---------- */

/**
 * The Gemini card. Signing in with Google is offered, and what is honestly true about it is on
 * the card before you press anything: it only works against your own Google Cloud project. If
 * Google refuses the sign-in, the check says so in those words and the key flow stays.
 */
async function loadGemini() {
  const note = $("gemini-signin-note");
  if (!note) return;
  try {
    const state = await request("/api/models/gemini-signin");
    note.textContent = state.note;
    $("gemini-client-id").value = state.settings.clientId || "";
    $("gemini-signin-model").value = state.settings.model || "";
    if (state.connected) $("gemini-signin-status").textContent = "Signed in with Google for Gemini.";
  } catch (error) { note.textContent = error.message; }
}

async function signInWithGoogle() {
  const status = $("gemini-signin-status");
  status.textContent = "Signing in…";
  try {
    await request("/api/models/gemini-signin", {
      clientId: $("gemini-client-id").value.trim(),
      model: $("gemini-signin-model").value.trim() || "gemini-2.5-flash",
    });
    status.textContent = "Signed in. Checking whether Google will actually take it…";
    await checkGemini(status);
  } catch (error) { status.textContent = error.message; }
}

/** Asks the signed-in connection what models it has, and repeats Google's answer in plain words. */
async function checkGemini(status) {
  try {
    const { connection } = await request("/api/models/probe", { id: "google-gemini" });
    status.textContent = [connection.summary, connection.fix].filter(Boolean).join(" ");
  } catch (error) { status.textContent = error.message; }
}

function start() {
  $("model-profile-save")?.addEventListener("click", () => void saveProfiles());
  $("model-profile-active")?.addEventListener("change", () => void showWhy());
  $("model-probe-run")?.addEventListener("click", () => void probeConnections());
  $("gemini-signin")?.addEventListener("click", () => void signInWithGoogle());
  if (connected()) { void loadProfiles(); void loadGemini(); }
}
/** app.js calls this once you have connected, which is the first moment settings can be read. */
const waiting = globalThis.branchVoiceReady;
globalThis.branchVoiceReady = () => { waiting?.(); void loadProfiles(); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
