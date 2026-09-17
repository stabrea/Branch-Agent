/**
 * Wave mac2: editing an earlier message. Each of your messages gets an Edit button; changing the
 * words offers to go back to just before that message — the conversation only, the files only, or
 * both — and then sends the new words. "Undo that" (the button, or those words typed on their own)
 * puts everything back the way it was before going back.
 *
 * The pure pieces are exported so they can be tested without a browser.
 */
export const CHOICES = [
  ["both", "Conversation and files"],
  ["conversation", "Conversation only"],
  ["files", "Files only"],
];

/** Your messages in a conversation, in the order the page shows them. */
export function userEntries(view) {
  return (view?.messages ?? []).filter((m) => m.role === "user").map((m) => ({ messageId: m.messageId, content: m.content }));
}

/** "undo that", on its own, with or without a full stop. */
export function isUndoThat(text) {
  return /^\s*undo that\s*[.!]?\s*$/i.test(String(text ?? ""));
}

/** One sentence saying what going back did. */
export function describeRewind(result) {
  const parts = [];
  if (result.messagesRemoved) parts.push(`${result.messagesRemoved} message${result.messagesRemoved === 1 ? "" : "s"} taken back`);
  const files = result.files;
  if (files && files.method !== "none") parts.push(`${files.changed} file${files.changed === 1 ? "" : "s"} put back${files.removed ? `, ${files.removed} removed` : ""}`);
  const said = parts.length ? `Went back: ${parts.join("; ")}.` : "Went back. Nothing needed changing.";
  return files?.note ? `${said} ${files.note}` : said;
}

if (typeof document !== "undefined") void boot();

async function boot() {
  const app = await import("/app.js");
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (label, handler) => {
    const node = el("button", label, "text-button");
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };
  const session = () => globalThis.branchSessionId?.() || "";
  const bar = el("div", undefined, "plan-card rewind-undo");
  bar.id = "rewind-undo";
  bar.hidden = true;
  $("composer-dock")?.prepend(bar);
  let undoFor = "";

  const showUndo = (sessionId, text) => {
    undoFor = sessionId;
    bar.replaceChildren(el("p", text), button("Undo that", () => void unrevert(sessionId)));
    bar.hidden = false;
  };
  const refreshUndo = async () => {
    const sessionId = session();
    if (!sessionId) { undoFor = ""; bar.hidden = true; return; }
    try {
      const status = await app.api(`sessions/${sessionId}/rewind`);
      if (status.undo) { if (bar.hidden || undoFor !== sessionId) showUndo(sessionId, "You went back to an earlier message in this conversation."); }
      else { undoFor = ""; bar.hidden = true; }
    } catch { /* nothing to offer */ }
  };
  const unrevert = async (sessionId) => {
    try {
      const result = await app.api(`sessions/${sessionId}/unrevert`, {});
      await app.openConversation(sessionId);
      app.toast(`Put back ${result.messagesRestored} message(s)${result.files ? ` and ${result.files.changed} file(s)` : ""}.`);
    } catch (error) { app.toast(error.message); }
    await refreshUndo();
  };

  const editor = (node, entry, sessionId, status) => {
    const form = el("form", undefined, "rewind-editor");
    const text = el("textarea");
    text.value = entry.content;
    text.rows = 3;
    text.maxLength = 16000;
    text.setAttribute("aria-label", "Your edited message");
    const choices = el("fieldset");
    choices.append(el("legend", "Go back to just before this message, for:"));
    for (const [value, label] of CHOICES) {
      const row = el("label", undefined, "check");
      const radio = el("input");
      radio.type = "radio"; radio.name = `rewind-${entry.messageId}`; radio.value = value; radio.checked = value === "both";
      row.append(radio, ` ${label}`);
      choices.append(row);
    }
    form.append(text, choices);
    if (status.note) form.append(el("p", status.note, "meta"));
    const send = el("button", "Go back and send", "text-button");
    send.type = "submit";
    form.append(send, button("Cancel", () => form.remove()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const restore = form.querySelector("input[type=radio]:checked")?.value || "both";
      void goBack(sessionId, entry.messageId, restore, text.value.trim(), form);
    });
    node.append(form);
    text.focus();
  };
  const goBack = async (sessionId, messageId, restore, words, form) => {
    if (!words) { app.toast("Write the message to send."); return; }
    try {
      const result = await app.api(`sessions/${sessionId}/rewind`, { messageId, restore });
      form.remove();
      await app.openConversation(sessionId);
      showUndo(sessionId, describeRewind(result));
      $("prompt").value = words;
      $("chat-form").requestSubmit();
    } catch (error) { app.toast(error.message); }
  };
  const edit = async (node) => {
    const sessionId = session();
    if (!sessionId || node.querySelector(".rewind-editor")) return;
    try {
      const nodes = [...$("conversation").querySelectorAll(".message.user")];
      const entries = userEntries(await app.api(`sessions/${sessionId}`));
      const entry = entries.length === nodes.length ? entries[nodes.indexOf(node)] : null;
      if (!entry?.messageId) { app.toast("This message is still being saved. Try again in a moment."); return; }
      editor(node, entry, sessionId, await app.api(`sessions/${sessionId}/rewind`));
    } catch (error) { app.toast(error.message); }
  };
  const decorate = () => {
    if (!session()) return;
    for (const node of $("conversation")?.querySelectorAll(".message.user:not([data-rewind])") ?? []) {
      node.dataset.rewind = "1";
      const controls = el("div", undefined, "message-controls");
      controls.append(button("Edit", () => void edit(node)));
      node.append(controls);
    }
  };
  const conversation = $("conversation");
  let checkedFor = "";
  if (conversation) new MutationObserver(() => {
    decorate();
    if (checkedFor !== session()) { checkedFor = session(); void refreshUndo(); }
  }).observe(conversation, { childList: true });

  // Runs before the message box's own handler: "undo that" on its own undoes the last going back.
  document.addEventListener("submit", (event) => {
    if (event.target?.id !== "chat-form" || !isUndoThat($("prompt").value)) return;
    const sessionId = session();
    if (!sessionId || bar.hidden || undoFor !== sessionId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    $("prompt").value = "";
    void unrevert(sessionId);
  }, true);
}
