/* mac7/r17-g: the safety extras, five cards in settings:permissions, each placed by public/layout.js
   through data-home. Every part has the owner's three-way switch and starts off; the emergency stop
   starts unpressed. Every word goes through a key with real French, every control has a label and a
   description (aria-describedby), and no colour is written here. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { segmented } from "/control-makers.js";

const HOME = "settings:permissions";
const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  // Fingerprints, keys and links have no spaces; they wrap anywhere rather than widen the card at 400 px.
  node.style.overflowWrap = "anywhere";
  return node;
}
/** A label, the control, and one sentence describing it, tied together for screen readers. */
function described(id, key, english, hintKey, hint, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  const note = make("p", "field-note", hintKey, hint);
  note.id = `${id}-hint`;
  control.setAttribute("aria-describedby", note.id);
  return [label, control, note];
}
function input(type = "text", value = "") {
  const node = document.createElement(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") node.type = type;
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value;
  return node;
}
function button(id, key, english, hintKey, hint, handler, primary = false) {
  const node = make("button", primary ? "primary" : "quiet-button", key, english);
  node.type = "button";
  node.id = id;
  node.title = say(hintKey, hint);
  node.dataset.tTitle = hintKey;
  node.setAttribute("aria-description", node.title);
  node.dataset.tAriaDescription = hintKey; // re-worded with the rest when the language changes
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "safety.saved"; node.textContent = say("safety.saved", "Saved."); };
/** The code typed on the codes card, for a change that takes the codes' guard away (integration review). */
const typedCode = () => { const value = $("safety-codes-code")?.value.trim(); return value ? { code: value } : {}; };
function card(id, titleKey, title, purposeKey, purpose) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = HOME;
  node.append(make("h2", "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  return { node, status };
}

const POSITIONS = [["off", "field.switch-off", "Off"], ["when-needed", "field.switch-when-needed", "Only when it is needed"], ["on", "field.switch-on", "On"]];
const PARTS = {
  "tool-scripts": ["safety.part.toolScripts", "Scripts that call several tools at once",
    "safety.hint.toolScripts", "A script runs walled off with no internet; every tool it calls is checked like a direct call."],
  "wasm-add-ons": ["safety.part.wasm", "Add-ons in a sealed WebAssembly box",
    "safety.hint.wasm", "An add-on gets only its input, a memory limit and a time limit. Nothing else."],
  "code-approvals": ["safety.part.codes", "Authenticator codes for chosen yeses",
    "safety.hint.codes", "When needed: only for work you did not start yourself. On: for every listed tool."],
  "command-scan": ["safety.part.scan", "Checking commands for tricks",
    "safety.hint.scan", "Look-alike letters and piped downloads are asked about; hidden terminal codes are refused. When needed: only commands your rules would run without asking."],
  "progress-judge": ["safety.part.progress", "Asking whether a long task is getting anywhere",
    "safety.hint.progress", "Repeated text ends a task. A short check with the model runs every few rounds of a long task."],
  "activity-chain": ["safety.part.chain", "A tamper-evident chain over what happened",
    "safety.hint.chain", "When needed: permissions, refusals and questions. On: every tool as well."],
  "history-repair": ["safety.part.repair", "Tidying a conversation before it is sent",
    "safety.hint.repair", "When needed: only what model services refuse. On: also joins messages in a row."],
};

/* ---------- the switches, and trying a command ---------- */
function switchesCard(state) {
  const { node, status } = card("safety-extras-card", "safety.extras.title", "Safety extras",
    "safety.extras.purpose", "Extra checks and limits. Each one starts off.");
  for (const [part, [key, english, hintKey, hint]] of Object.entries(PARTS)) {
    const control = segmented({
      id: `safety-switch-${part}`,
      options: POSITIONS,
      value: state.modes[part],
      onChange: async (value) => {
        const code = part === "code-approvals" ? typedCode() : {};
        try { await api("safety-extras/switch", { part, mode: value, ...code }); done(status); }
        catch (error) { control.value = state.modes[part]; tell(status, error); }
      }
    });
    node.append(...described(`safety-switch-${part}`, key, english, hintKey, hint, control));
  }
  const command = input();
  const result = make("p", "subtle");
  node.append(...described("safety-scan-command", "safety.scan.label", "Check a command", "safety.scan.hint", "Paste a command to see what the check would say. Nothing is run.", command),
    button("safety-scan-run", "safety.scan.run", "Check", "safety.scan.runHint", "Checks the command without running it", async () => {
      try {
        const answer = await api("safety-extras/scan", { command: command.value });
        if (answer.sentence) { delete result.dataset.t; result.textContent = answer.sentence; }
        else { result.dataset.t = "safety.scan.clean"; result.textContent = say("safety.scan.clean", "Nothing found."); }
      } catch (error) { tell(result, error); }
    }), result, status);
  return node;
}

/* ---------- the emergency stop ---------- */
function stopCard(state) {
  const { node, status } = card("safety-stop-card", "safety.stop.title", "Emergency stop",
    "safety.stop.purpose", "Refuse tools straight away, at the level you choose, until you let it go.");
  const stop = state.stop;
  const now = make("p", "", stop.engaged ? "safety.stop.on" : "safety.stop.off", stop.engaged ? "The emergency stop is on." : "The emergency stop is off.");
  const everything = input("checkbox", stop.everything), network = input("checkbox", stop.network);
  const sites = input("text", stop.sites.join(", ")), tools = input("text", stop.tools.join(", "));
  const list = (field) => field.value.split(",").map((item) => item.trim()).filter(Boolean);
  const code = input("text");
  code.inputMode = "numeric";
  code.autocomplete = "one-time-code";
  node.append(now,
    ...described("safety-stop-everything", "safety.stop.everything", "Every tool", "safety.stop.everythingHint", "No tool runs at all.", everything),
    ...described("safety-stop-network", "safety.stop.network", "Everything that reaches past this computer", "safety.stop.networkHint", "The web, the browser, messages, programs and scripts, and every address.", network),
    ...described("safety-stop-sites", "safety.stop.sites", "Sites", "safety.stop.sitesHint", "Names separated by commas, such as example.com.", sites),
    ...described("safety-stop-tools", "safety.stop.tools", "Tools", "safety.stop.toolsHint", "Tool names separated by commas; a star matches the rest, as in browser.*.", tools),
    button("safety-stop-press", "safety.stop.press", "Press the stop", "safety.stop.pressHint", "Adds these levels to whatever is already stopped", async () => {
      try { await api("safety-extras/stop", { everything: everything.checked, network: network.checked, sites: list(sites), tools: list(tools) }); await drawCards(); }
      catch (error) { tell(status, error); }
    }, true),
    ...described("safety-stop-code", "safety.stop.code", "Authenticator code", "safety.stop.codeHint", "Needed to let the stop go when you chose that below.", code),
    button("safety-stop-release", "safety.stop.release", "Let it go", "safety.stop.releaseHint", "Releases every level of the stop", async () => {
      try { await api("safety-extras/stop/release", code.value ? { code: code.value } : {}); await drawCards(); } catch (error) { tell(status, error); }
    }),
    status);
  return node;
}

/* ---------- authenticator codes ---------- */
function codesCard(state) {
  const { node, status } = card("safety-codes-card", "safety.codes.title", "Authenticator codes",
    "safety.codes.purpose", "Ask for the six-digit code from your authenticator app before chosen yeses.");
  const codes = state.codes;
  const stateKey = codes.enrolled ? "safety.codes.enrolled" : codes.pending ? "safety.codes.pending" : "safety.codes.none";
  const stateText = codes.enrolled ? "Your authenticator app is set up." : codes.pending ? "Type the first code from your app to finish." : "No authenticator app is set up.";
  const tools = input("textarea", codes.tools.join("\n"));
  const release = input("checkbox", codes.releaseNeedsCode);
  const code = input("text");
  code.inputMode = "numeric";
  code.autocomplete = "one-time-code";
  const link = plain("p", "", "field-note");
  node.append(make("p", "", stateKey, stateText),
    ...described("safety-codes-tools", "safety.codes.tools", "Tools that need a code", "safety.codes.toolsHint", "One per line; a star matches the rest, as in payments.*.", tools),
    ...described("safety-codes-release", "safety.codes.release", "Letting the emergency stop go needs a code", "safety.codes.releaseHint", "Pressing the stop never needs one.", release),
    button("safety-codes-save", "safety.codes.save", "Save", "safety.codes.saveHint", "Saves the list and the choice above", async () => {
      try { await api("safety-extras/codes", { tools: tools.value.split("\n").map((line) => line.trim()).filter(Boolean), releaseNeedsCode: release.checked, ...typedCode() }); done(status); }
      catch (error) { tell(status, error); }
    }, true),
    button("safety-codes-begin", "safety.codes.begin", "Set up an app", "safety.codes.beginHint", "Makes a new key; add it to your authenticator app", async () => {
      try { const answer = await api("safety-extras/codes/begin", typedCode()); link.textContent = `${answer.key} · ${answer.uri}`; } catch (error) { tell(status, error); }
    }),
    link,
    ...described("safety-codes-code", "safety.codes.code", "Code from your app", "safety.codes.codeHint", "Six digits; a new one appears every thirty seconds. While codes are on, changing or removing them needs one too.", code),
    button("safety-codes-finish", "safety.codes.finish", "Confirm", "safety.codes.finishHint", "Finishes setting up the app with its first code", async () => {
      try { await api("safety-extras/codes/finish", { code: code.value }); link.textContent = ""; await drawCards(); } catch (error) { tell(status, error); }
    }),
    button("safety-codes-remove", "safety.codes.remove", "Remove the app", "safety.codes.removeHint", "Forgets the key; no yes needs a code afterwards", async () => {
      try { await api("safety-extras/codes/remove", typedCode()); await drawCards(); } catch (error) { tell(status, error); }
    }),
    status);
  return node;
}

/* ---------- the activity chain ---------- */
function chainCard(state) {
  const { node, status } = card("safety-chain-card", "safety.chain.title", "Tamper-evident record",
    "safety.chain.purpose", "Each entry carries the fingerprint of the one before, so a changed entry shows.");
  const summary = plain("p", `${state.chain.entries} · ${state.chain.tip}`, "field-note");
  const tip = input();
  node.append(make("p", "", "safety.chain.latest", "Entries and latest fingerprint:"), summary,
    ...described("safety-chain-tip", "safety.chain.tip", "A fingerprint you wrote down", "safety.chain.tipHint", "Optional: the check also makes sure this one is still there.", tip),
    button("safety-chain-verify", "safety.chain.verify", "Check the record", "safety.chain.verifyHint", "Walks the whole record and says where it first breaks", async () => {
      try {
        const { check } = await api("safety-extras/activity/verify", tip.value.trim() ? { tip: tip.value.trim() } : {});
        if (check.ok) { status.dataset.t = "safety.chain.ok"; status.textContent = say("safety.chain.ok", "The record is unbroken."); }
        else { delete status.dataset.t; status.textContent = check.reason; }
      } catch (error) { tell(status, error); }
    }, true),
    status);
  return node;
}

/* ---------- WebAssembly add-ons ---------- */
/** The operations a module may be granted, in the same order the host checks them in. Each one gets
 * its own checkbox so an add-on can be given fewer than the shared list allows. */
const WASM_CAPABILITIES = [
  ["input_size", "safety.wasm.cap.input_size", "How much input there is"],
  ["read_input", "safety.wasm.cap.read_input", "Read the input"],
  ["write_output", "safety.wasm.cap.write_output", "Write the answer"],
  ["log", "safety.wasm.cap.log", "Write to the log"],
];
function wasmCard(state) {
  const { node, status } = card("safety-wasm-card", "safety.wasm.title", "WebAssembly add-ons",
    "safety.wasm.purpose", "Small add-ons that run sealed: no files, no internet, a memory and time limit.");
  const list = document.createElement("ul");
  for (const addOn of state.wasm) {
    const granted = Array.isArray(addOn.capabilities) ? addOn.capabilities.join(", ") : "";
    const item = plain("li", `${addOn.name} — ${addOn.description || addOn.sha256.slice(0, 16)} (${granted || "no operations"}) `);
    item.append(button(`safety-wasm-remove-${addOn.name}`, "safety.wasm.remove", "Remove", "safety.wasm.removeHint", "Removes this add-on", async () => {
      try { await api("safety-extras/wasm/remove", { name: addOn.name }); await drawCards(); } catch (error) { tell(status, error); }
    }));
    list.append(item);
  }
  if (!state.wasm.length) list.append(make("li", "", "safety.wasm.none", "No add-ons yet."));
  const name = input(), about = input(), file = input("file");
  file.accept = ".wasm,application/wasm";
  const capsLegend = make("legend", "safety.wasm.capabilities", "What it may use");
  const capsHint = make("p", "field-note", "safety.wasm.capabilitiesHint",
    "Uncheck what this add-on should never be given, even though it is allowed elsewhere.");
  const capsHintId = "safety-wasm-capabilities-hint";
  capsHint.id = capsHintId;
  const capBoxes = WASM_CAPABILITIES.map(([capName, key, english]) => {
    const box = input("checkbox", true);
    const label = make("label", "", key, english);
    label.htmlFor = `safety-wasm-cap-${capName}`;
    box.id = label.htmlFor;
    box.setAttribute("aria-describedby", capsHintId); // one shared hint for the group, not one per box
    return { capName, label, control: box };
  });
  const fieldset = document.createElement("fieldset");
  fieldset.setAttribute("aria-describedby", capsHintId);
  fieldset.append(capsLegend, ...capBoxes.flatMap(({ label, control }) => [label, control]), capsHint);
  node.append(list,
    ...described("safety-wasm-name", "safety.wasm.name", "Name", "safety.wasm.nameHint", "Lowercase letters, digits and dashes.", name),
    ...described("safety-wasm-about", "safety.wasm.about", "What it does", "safety.wasm.aboutHint", "One sentence, for you and the assistant.", about),
    ...described("safety-wasm-file", "safety.wasm.file", "The .wasm file", "safety.wasm.fileHint", "It may use only Branch's input, output and log.", file),
    fieldset,
    button("safety-wasm-install", "safety.wasm.install", "Install", "safety.wasm.installHint", "Checks the file and keeps it with its fingerprint", async () => {
      try {
        const bytes = new Uint8Array(await file.files[0].arrayBuffer());
        let binary = "";
        for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
        const capabilities = capBoxes.filter(({ control }) => control.checked).map(({ capName }) => capName);
        await api("safety-extras/wasm", { name: name.value.trim(), description: about.value.trim(), wasm: btoa(binary), capabilities });
        await drawCards();
      } catch (error) { tell(status, error); }
    }, true),
    status);
  return node;
}

const BUILDERS = [["safety-extras-card", switchesCard], ["safety-stop-card", stopCard], ["safety-codes-card", codesCard],
  ["safety-chain-card", chainCard], ["safety-wasm-card", wasmCard]];

async function drawCards() {
  let state;
  try { state = await api("safety-extras"); } catch { return; }
  for (const [id, build] of BUILDERS) {
    try {
      const fresh = build(state);
      const old = $(id);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}

whenReady(() => { void drawCards(); });
// Sentences made from the server's answers are drawn again in the language just chosen.
document.addEventListener("branch-language", () => { if ($("safety-extras-card")) void drawCards(); });
