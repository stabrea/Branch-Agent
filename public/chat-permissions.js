/**
 * The card for what a chat message's task may use: a switch, and the owner's own lines saying which
 * chat app and which person may do more than read and answer. It only reads and writes that one
 * setting; see src/channels/chat-permissions.ts for what the short list is and why. Its home is
 * Customize, Chat apps.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (text) => { const line = $("chat-permissions-state"); if (line) line.textContent = text; };
/** The lines as they are on the page now; the page is the only copy while the owner edits. */
let rules = [];

const names = (text) => [...new Set(String(text).split(",").map((word) => word.trim()).filter(Boolean))].slice(0, 20);

function draw() {
  const list = $("chat-permissions-list");
  if (!list) return;
  list.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "field-note";
    empty.dataset.t = "settings.chat-permissions.empty";
    empty.textContent = t("settings.chat-permissions.empty");
    list.append(empty);
    return;
  }
  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "item";
    const words = document.createElement("span");
    // A line that may answer yes from the chat says so where the owner reads the list, not only in
    // the box they ticked once: it is the part of a line that gives the most away.
    const answering = rule.approvals ? ` · ${t("settings.chat-permissions.may-answer")}` : "";
    words.textContent = `${rule.channel} · ${rule.sender} · ${rule.allow.join(", ")}${answering}${rule.note ? ` · ${rule.note}` : ""}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.t = "action.remove-chat-permission";
    remove.textContent = t("action.remove-chat-permission");
    remove.addEventListener("click", () => { rules.splice(index, 1); draw(); });
    row.append(words, remove);
    list.append(row);
  });
}

function show(permissions) {
  $("chat-permissions-extras").checked = permissions?.extras === true;
  rules = (permissions?.rules ?? []).map((rule) => ({ ...rule, allow: [...rule.allow] }));
  draw();
}

/** Only asks once the owner is in: before that there is no key and the answer would be a refusal. */
async function load() {
  const signedIn = document.getElementById("workspace");
  if (!$("chat-permissions-form") || !signedIn || signedIn.hidden) return;
  show((await api("channels")).permissions);
}

/** Saving takes whatever is typed in the row of fields as one more line, when it names anything. */
async function save(event) {
  event.preventDefault();
  const allow = names($("chat-permissions-allow").value);
  const next = allow.length
    ? [...rules, { channel: $("chat-permissions-channel").value.trim() || "*", sender: $("chat-permissions-sender").value.trim() || "*",
      allow, note: $("chat-permissions-note").value.trim(),
      // Off unless the owner ticked it for this line, so a line written without a thought for it
      // keeps the old rule: the yes belongs in the window.
      approvals: $("chat-permissions-approvals").checked === true }]
    : rules;
  try {
    show((await api("channels/permissions", { extras: $("chat-permissions-extras").checked, rules: next.slice(0, 50) })).permissions);
    $("chat-permissions-allow").value = "";
    $("chat-permissions-note").value = "";
    $("chat-permissions-approvals").checked = false;
    say(t("settings.chat-permissions.saved"));
  } catch (error) {
    say(t("settings.chat-permissions.failed", { reason: error instanceof Error ? error.message : String(error) }));
  }
}

$("chat-permissions-form")?.addEventListener("submit", save);
/* The card shows a fresh install's state — off, with no lines — before anything is asked for, so a
   setting that will not load leaves it saying the safe thing rather than saying nothing. */
draw();
load().catch(() => {});
/* On a fresh window the key is not there yet, so the card loads again once the owner is in. */
const workspace = document.getElementById("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) load().catch(() => {}); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
