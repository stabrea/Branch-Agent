/**
 * R17-S06: what comes straight after first run. First run already ends in the conversation with
 * the message box ready (`public/app.js`, "Done, start chatting"). This card sits above that
 * conversation and offers three things, none of which happens without a click:
 *
 *   Say hello          sends a first message, so the first thing seen is a real answer
 *   Watch me once      switches on recording each task ("only when it is needed"), so the next
 *                      task can be saved as a workflow from Inbox › History
 *   Suggested automations  put a ready-made request in the message box to read and send
 *
 * "Not now" closes it. It is shown once per browser.
 *
 * OWNER-LIST 7, part two: a second card, "Two more things, if you like", comes first and stays
 * visible in the calm window. Connect email and calendar with the owner's own sign-in, or bring a
 * backup back after a plain "this replaces" yes. Both are optional; nothing happens without a click.
 * First run's own trouble line (try again, then another way, raw text behind Details) and the
 * copyable ChatGPT code live here too, so `public/app.js` only calls them.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const SEEN = "branch-first-run-next";
const say = (key, english) => { const words = t(key); return words === key ? english : words; };
const sayWith = (key, english, values) => {
  const words = t(key, values);
  return words === key ? english.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole)) : words;
};
function el(tag, key, english, className) {
  const node = document.createElement(tag);
  if (key) node.dataset.t = key;
  if (english !== undefined) node.textContent = key ? say(key, english) : english;
  if (className) node.className = className;
  return node;
}
function action(key, english, onClick, filled = false) {
  const node = el("button", key, english, filled ? "" : "quiet-button");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const SUGGESTIONS = [
  ["first-run-next.suggest.brief", "Every weekday at 8 in the morning, give me a short summary of what changed in my workspace."],
  ["first-run-next.suggest.tidy", "Once a week, look through my Downloads folder and suggest what I can delete. Do not delete anything yourself."],
  ["first-run-next.suggest.watch", "Check this page every day and tell me when it changes: "],
];

/** Puts words in the message box and, when asked, sends them. */
function compose(words, send) {
  const prompt = document.getElementById("prompt");
  if (!prompt) return;
  prompt.value = words;
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  if (send) document.getElementById("chat-form")?.requestSubmit();
}

async function watchMeOnce(status) {
  status.textContent = say("first-run-next.watch-working", "Switching on…");
  try {
    const plan = { source: "set", key: "run-recording", field: "mode", value: "when-needed" };
    await api("settings-kit/apply", { plan, accept: ["run-recording.mode"], confirmLoosening: false });
    status.textContent = say("first-run-next.watch-done",
      "Recording is on. Do the task once in this conversation, then open it in Inbox › History and choose to save it as a workflow.");
  } catch (error) { status.textContent = error.message; }
}

function build() {
  const card = el("section", undefined, undefined, "card first-run-next");
  card.id = "first-run-next";
  const status = el("p", undefined, undefined, "meta");
  status.setAttribute("role", "status");
  const close = () => { card.remove(); try { localStorage.setItem(SEEN, "1"); } catch { /* forgotten in a private window */ } };
  const chips = el("div", undefined, undefined, "first-run-next-chips");
  chips.append(...SUGGESTIONS.map(([key, english]) => action(key, english, () => compose(say(key, english), false))));
  card.append(
    el("h2", "first-run-next.title", "You're ready"),
    el("p", "first-run-next.purpose", "Your assistant is answering. Say hello to see it work, or pick something to try."),
    action("first-run-next.hello", "Say hello", () => { compose(say("first-run-next.hello-words", "Hello! In two sentences, what can you help me with?"), true); close(); }, true),
    el("h3", "first-run-next.watch-title", "Show it once"),
    el("p", "first-run-next.watch-purpose", "Do a task yourself in a conversation and it can be saved as a workflow to run again.", "subtle"),
    action("first-run-next.watch", "Watch me once", () => watchMeOnce(status)),
    el("h3", "first-run-next.suggest-title", "Suggested automations"),
    el("p", "first-run-next.suggest-purpose", "Each one only fills in the message box. Read it, change it, and send it if you want it.", "subtle"),
    chips, status,
    action("first-run-next.later", "Not now", close),
  );
  return card;
}

export function showFirstRunNext() {
  if (document.getElementById("first-run-next")) return;
  const firstRun = document.getElementById("first-run");
  if (!firstRun) return;
  firstRun.after(build());
}

/* ---------- part two: two optional steps, email and bringing a backup back ---------- */
const STEPS_SEEN = "branch-first-run-steps";
const SIGN_INS = [["google", "Google"], ["microsoft", "Microsoft"]];

async function emailStep() {
  const step = el("section", undefined, undefined, "first-run-step");
  step.append(el("h3", "first-run-steps.email-title", "Your email and calendar"),
    el("p", "first-run-steps.email-purpose", "Let Branch read your mail and calendar with your own sign-in. It never sends mail.", "subtle"));
  const connected = [];
  for (const [service, name] of SIGN_INS) {
    const answer = await api(`personal/signin/${service}`).catch(() => null);
    if (answer?.status?.signedIn) connected.push(name);
  }
  if (connected.length) {
    step.append(el("p", undefined, sayWith("first-run-steps.email-connected", "Connected: {names}.", { names: connected.join(", ") }), "meta"));
    return step;
  }
  step.append(action("first-run-steps.email-go", "Set it up", () => globalThis.branchLayout?.go("customize:connections")));
  return step;
}

/** Sent only after the owner said yes; the route also refuses a Branch that already has conversations. */
async function bringBack(file, status) {
  status.textContent = say("first-run-steps.restore-working", "Bringing it back…");
  let archive;
  try { archive = JSON.parse(await file.text()); } catch {
    status.textContent = say("first-run-steps.restore-not-backup", "That file is not a Branch backup. Nothing was changed.");
    return;
  }
  try {
    const result = await api("restore", archive);
    status.textContent = sayWith("first-run-steps.restore-done", "Brought back {count} items. Opening it now…", { count: result.rows });
    try { localStorage.setItem(STEPS_SEEN, "1"); } catch { /* shown again, harmless */ }
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    status.textContent = /already has/.test(error.message)
      ? say("first-run-steps.restore-has-state", "This Branch already has conversations, so nothing was changed. A backup can only go into a Branch that has none yet.")
      : say("first-run-steps.restore-not-backup", "That file is not a Branch backup. Nothing was changed.");
  }
}

function restoreStep() {
  const step = el("section", undefined, undefined, "first-run-step");
  const status = el("p", undefined, undefined, "meta");
  status.setAttribute("role", "status");
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".json,application/json";
  file.id = "first-run-restore-file";
  file.hidden = true;
  const confirm = el("div", undefined, undefined, "first-run-confirm");
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen) askFirst(confirm, chosen, status);
  });
  step.append(el("h3", "first-run-steps.restore-title", "Bring back your Branch"),
    el("p", "first-run-steps.restore-purpose",
      "Have a backup file from before? Put your conversations, memory and settings back. Passwords and keys are never in a backup, so add those again.", "subtle"),
    file, action("first-run-steps.restore-go", "Choose the backup file", () => file.click()), confirm, status);
  return step;
}

/** Nothing is sent until the owner has read that what is here now will be replaced, and said yes. */
function askFirst(confirm, chosen, status) {
  status.textContent = "";
  const choices = el("div", undefined, undefined, "identity-actions");
  choices.append(
    action("first-run-steps.restore-yes", "Yes, replace it", () => { confirm.replaceChildren(); void bringBack(chosen, status); }, true),
    action("first-run-steps.restore-no", "Cancel", () => { confirm.replaceChildren(); status.textContent = say("first-run-steps.restore-cancelled", "Nothing was changed."); }));
  confirm.replaceChildren(
    el("p", undefined, sayWith("first-run-steps.restore-confirm",
      "Bring back {name}? This replaces the settings and data already in this Branch with the ones in the file.", { name: chosen.name })),
    choices);
}

async function buildSteps() {
  const card = el("section", undefined, undefined, "card first-run-steps");
  card.id = "first-run-steps";
  card.setAttribute("aria-labelledby", "first-run-steps-title");
  const title = el("h2", "first-run-steps.title", "Two more things, if you like");
  title.id = "first-run-steps-title";
  const close = () => { card.remove(); try { localStorage.setItem(STEPS_SEEN, "1"); } catch { /* shown again, harmless */ } };
  card.append(title, el("p", "first-run-steps.purpose", "Both are optional. You can do them later in Settings."),
    await emailStep(), restoreStep(), action("first-run-steps.done", "Done", close, true));
  return card;
}

export async function showFirstRunSteps() {
  if (document.getElementById("first-run-steps")) return;
  const card = await buildSteps();
  if (document.getElementById("first-run-steps")) return;
  (document.getElementById("first-run-next") ?? document.getElementById("first-run"))?.before(card);
}

/* ---------- first run's own trouble line and sign-in code ---------- */
/** A failed try, in the order a stuck person needs: again, then another way; raw words behind Details. */
export function showFirstRunTrouble(status, error) {
  if (!status) return false;
  const click = (id) => () => { status.textContent = ""; document.getElementById(id)?.click(); };
  const details = document.createElement("details");
  details.append(el("summary", "first-run-trouble.details", "Details"), el("pre", undefined, String(error?.message ?? error)));
  const choices = el("div", undefined, undefined, "identity-actions");
  choices.append(action("first-run-trouble.retry", "Try again", click("first-run-test"), true),
    action("first-run-trouble.back", "Choose another way", () => { status.textContent = ""; document.querySelector("#first-run .door")?.focus(); }));
  status.replaceChildren(el("span", "first-run-trouble.said", "It did not answer. You can:"), choices, details);
  return true;
}

/** The sign-in code one character to a box, and one button that copies the whole code. */
export function showDeviceCode(status, code) {
  if (!status || !code) return;
  const row = el("span", undefined, undefined, "first-run-code");
  row.setAttribute("aria-label", code);
  for (const character of String(code)) row.append(el("span", undefined, character, "first-run-code-cell"));
  const copy = action("first-run-code.copy", "Copy the code", async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = say("first-run-code.copied", "Copied"); }
    catch { copy.textContent = code; }
  });
  status.append(el("span", undefined, " "), row, copy);
}

if (typeof document !== "undefined") {
  globalThis.branchFirstRunTrouble = showFirstRunTrouble;
  globalThis.branchDeviceCode = showDeviceCode;
  globalThis.branchFirstRunDone = () => {
    let seen = false, stepsSeen = false;
    try { seen = localStorage.getItem(SEEN) === "1"; stepsSeen = localStorage.getItem(STEPS_SEEN) === "1"; } catch { /* show them */ }
    if (!seen) showFirstRunNext();
    if (!stepsSeen) void showFirstRunSteps();
  };
}
