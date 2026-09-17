/**
 * Wave mac2: editing an earlier message. Each of your messages gets an Edit button; changing the
 * words offers to go back to just before that message — the conversation only, the files only, or
 * both — and then sends the new words. "Undo that" (the button, or those words typed on their own)
 * puts everything back the way it was before going back.
 *
 * Every word on screen comes from public/locales through `t`. The pure pieces are exported so they
 * can be tested without a browser.
 */
export const CHOICES = ["both", "conversation", "files"];

/** Your messages in a conversation, in the order the page shows them. */
export function userEntries(view) {
  return (view?.messages ?? []).filter((m) => m.role === "user").map((m) => ({ messageId: m.messageId, content: m.content }));
}

/** "undo that" (or the same words in the chosen language), on its own, with or without a full stop. */
export function isUndoThat(text, phrases = ["undo that"]) {
  const said = String(text ?? "").trim().replace(/[.!]$/, "").trim().toLowerCase();
  return phrases.some((phrase) => said === String(phrase).trim().toLowerCase());
}

/** One sentence saying what going back did, in the words `t` gives. */
export function describeRewind(result, t) {
  const parts = [];
  if (result.messagesRemoved) parts.push(t("rewind.messagesTaken", { count: result.messagesRemoved }));
  const files = result.files;
  if (files && files.method !== "none") {
    parts.push(t("rewind.filesPut", { count: files.changed }));
    if (files.removed) parts.push(t("rewind.filesRemoved", { count: files.removed }));
  }
  const said = parts.length ? t("rewind.wentBack", { parts: parts.join("; ") }) : t("rewind.nothing");
  return files?.note ? `${said} ${files.note}` : said;
}

if (typeof document !== "undefined") void boot();

async function boot() {
  const app = await import("/app.js");
  const { t } = await import("/i18n.js");
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  /** A button whose words come from `key`, so switching language (or the words arriving late) rewords it. */
  const button = (key, handler) => {
    const node = el("button", t(key), "text-button");
    node.dataset.t = key;
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
    bar.replaceChildren(el("p", text), button("rewind.undo", () => void unrevert(sessionId)));
    bar.hidden = false;
  };
  const refreshUndo = async () => {
    const sessionId = session();
    if (!sessionId) { undoFor = ""; bar.hidden = true; return; }
    try {
      const status = await app.api(`sessions/${sessionId}/rewind`);
      if (status.undo) { if (bar.hidden || undoFor !== sessionId) showUndo(sessionId, t("rewind.wentBackEarlier")); }
      else { undoFor = ""; bar.hidden = true; }
    } catch { /* nothing to offer */ }
  };
  const unrevert = async (sessionId) => {
    try {
      const result = await app.api(`sessions/${sessionId}/unrevert`, {});
      await app.openConversation(sessionId);
      app.toast(t("rewind.putBack", { messages: result.messagesRestored, files: result.files?.changed ?? 0 }));
    } catch (error) { app.toast(error.message); }
    await refreshUndo();
  };

  const editor = (node, entry, sessionId, status) => {
    const form = el("form", undefined, "rewind-editor");
    const text = el("textarea");
    text.value = entry.content;
    text.rows = 3;
    text.maxLength = 16000;
    text.setAttribute("aria-label", t("rewind.editLabel"));
    const choices = el("fieldset");
    choices.append(el("legend", t("rewind.legend")));
    for (const value of CHOICES) {
      const row = el("label", undefined, "check");
      const radio = el("input");
      radio.type = "radio"; radio.name = `rewind-${entry.messageId}`; radio.value = value; radio.checked = value === "both";
      row.append(radio, ` ${t(`rewind.choice.${value}`)}`);
      choices.append(row);
    }
    form.append(text, choices);
    if (status.note) form.append(el("p", status.note, "meta"));
    const send = el("button", t("rewind.send"), "text-button");
    send.type = "submit";
    form.append(send, button("rewind.cancel", () => form.remove()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const restore = form.querySelector("input[type=radio]:checked")?.value || "both";
      void goBack(sessionId, entry.messageId, restore, text.value.trim(), form);
    });
    node.append(form);
    text.focus();
  };
  const goBack = async (sessionId, messageId, restore, words, form) => {
    if (!words) { app.toast(t("rewind.empty")); return; }
    try {
      const result = await app.api(`sessions/${sessionId}/rewind`, { messageId, restore });
      form.remove();
      await app.openConversation(sessionId);
      showUndo(sessionId, describeRewind(result, t));
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
      if (!entry?.messageId) { app.toast(t("rewind.saving")); return; }
      editor(node, entry, sessionId, await app.api(`sessions/${sessionId}/rewind`));
    } catch (error) { app.toast(error.message); }
  };
  const decorate = () => {
    if (!session()) return;
    for (const node of $("conversation")?.querySelectorAll(".message.user:not([data-rewind])") ?? []) {
      node.dataset.rewind = "1";
      const controls = el("div", undefined, "message-controls");
      controls.append(button("rewind.edit", () => void edit(node)));
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
    if (event.target?.id !== "chat-form" || !isUndoThat($("prompt").value, ["undo that", t("rewind.undoPhrase")])) return;
    const sessionId = session();
    if (!sessionId || bar.hidden || undoFor !== sessionId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    $("prompt").value = "";
    void unrevert(sessionId);
  }, true);
}
