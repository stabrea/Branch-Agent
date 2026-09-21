/**
 * Labels where you actually look for a conversation: a row of chips above Recents and inside the
 * Ctrl+K box, and a small picker on the conversation's own title so you can put a label on what you
 * are reading. Every chip filters through the `labels` parameter the conversation search already
 * takes, so nothing new decides what matches.
 */
import { t } from "./i18n.js";
import { trackPopover } from "/popover.js";

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

/** Every label a conversation carries, with how many carry it, most used first. */
export async function conversationLabels() {
  try {
    return (await api("labels?target=conversation")).catalog ?? [];
  } catch { return []; }
}

/**
 * The chips. `chosen` is the Set of labels currently filtering; clicking one adds or removes it
 * and calls `onChange` with the new Set. Nothing is drawn when no conversation is labelled yet.
 */
export function labelChips(catalog, chosen, onChange) {
  const row = el("div", undefined, "label-chips");
  row.hidden = catalog.length === 0;
  for (const entry of catalog) {
    const chip = el("button", `${entry.label} (${entry.count})`, "label-chip");
    chip.type = "button";
    chip.dataset.label = entry.label;
    const on = chosen.has(entry.label);
    chip.setAttribute("aria-pressed", String(on));
    chip.addEventListener("click", () => {
      const next = new Set(chosen);
      if (on) next.delete(entry.label); else next.add(entry.label);
      onChange(next);
    });
    row.append(chip);
  }
  return row;
}

/** The conversations carrying every chosen label; an empty choice means "everything". */
export async function conversationsWithLabels(chosen) {
  const labels = [...chosen];
  const value = await api("sessions/search", { query: "", offset: 0, ...(labels.length ? { labels } : {}) });
  return value.sessions ?? [];
}

/* ---------- the picker on the conversation's own title ---------- */

let picker = null, tracked = null;
function closePicker() {
  const entry = tracked;
  tracked = null;
  entry?.close();
}

/** Puts a label on this conversation, or takes one off, without leaving the screen. */
export async function openLabelPicker(button, sessionId, afterChange) {
  if (picker) { closePicker(); return; }
  if (!sessionId) { globalThis.toast?.("Open a conversation first, then you can label it."); return; }
  picker = el("div", undefined, "label-picker");
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", t("labels.picker.title")); picker.dataset.tLabel = "labels.picker.title";
  const draw = async () => {
    const [catalog, mine] = await Promise.all([
      conversationLabels(),
      api(`labels?target=conversation`).then((v) => (v.labels ?? []).filter((row) => row.targetId === sessionId).map((row) => row.label)).catch(() => []),
    ]);
    const rows = [];
    const carried = new Set(mine);
    for (const entry of catalog) {
      const chip = el("button", entry.label, "label-chip");
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(carried.has(entry.label)));
      chip.addEventListener("click", async () => {
        const path = carried.has(entry.label) ? "labels/remove" : "labels";
        try { await api(path, { target: "conversation", targetId: sessionId, label: entry.label }); }
        catch (error) { globalThis.toast?.(error.message); }
        await draw();
        await afterChange?.();
      });
      rows.push(chip);
    }
    const field = el("input");
    field.type = "text";
    field.maxLength = 40;
    field.placeholder = t("labels.field.new");
    field.className = "label-new";
    const add = el("button", "Add", "label-add");
    add.type = "button";
    add.addEventListener("click", async () => {
      const label = field.value.trim();
      if (!label) return;
      try { await api("labels", { target: "conversation", targetId: sessionId, label }); field.value = ""; }
      catch (error) { globalThis.toast?.(error.message); }
      await draw();
      await afterChange?.();
    });
    const chips = el("div", undefined, "label-chips");
    chips.append(...rows);
    picker.replaceChildren(el("p", t("labels.picker.title"), "label-picker-head"), chips, field, add);
  };
  await draw();
  button.insertAdjacentElement("afterend", picker);
  /* Its own button, Escape and a click elsewhere close it, as every popover does (public/popover.js). */
  const shown = picker;
  tracked = trackPopover(button, shown, () => {
    shown.remove();
    if (picker === shown) { picker = null; tracked = null; }
    button.setAttribute("aria-expanded", "false");
  });
  button.setAttribute("aria-expanded", "true");
  shown.addEventListener("click", (event) => event.stopPropagation());
  picker.querySelector("button, input")?.focus();
}
