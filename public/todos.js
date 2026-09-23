/**
 * The to-do card in the context pane: what is still to be done, whether the assistant wrote it
 * down as part of a plan or the owner typed it in. A line with a day on it can be turned into a
 * reminder, which puts it in the schedules — the one place in the app that keeps time.
 */
import { api } from "/app.js";
import { formatDate, t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const say = (message) => { const box = $("todo-status"); if (box) box.textContent = message; };

/** One line: a tick box, the words, where it came from, and what to do with it. */
function todoRow(entry, redraw) {
  const row = el("div", undefined, "context-row todo-row");
  const label = el("label", undefined, "todo-label");
  const tick = el("input");
  tick.type = "checkbox";
  tick.checked = entry.done;
  tick.addEventListener("change", async () => {
    try { await api(`todos/${entry.id}/done`, { done: tick.checked }); await redraw(); }
    catch (error) { say(error.message); tick.checked = entry.done; }
  });
  label.append(tick, el("span", entry.text, entry.done ? "todo-done" : ""));
  row.append(label);

  const note = entry.source === "assistant" ? "Part of the assistant's plan" : "You added this";
  const when = entry.dueAt ? ` · wanted by ${formatDate(entry.dueAt)}` : "";
  row.append(el("span", note + when, "meta"));

  const buttons = el("div", undefined, "todo-actions");
  if (entry.dueAt && !entry.done) {
    const remind = el("button", t("todos.remind"), "text-button");
    remind.type = "button";
    remind.addEventListener("click", async () => {
      try { await api(`todos/${entry.id}/remind`, {}); say("Added to your schedules as a reminder."); }
      catch (error) { say(error.message); }
    });
    buttons.append(remind);
  }
  const drop = el("button", t("todos.remove"), "text-button");
  drop.type = "button";
  drop.addEventListener("click", async () => {
    try { await api(`todos/${entry.id}`, undefined, "DELETE"); await redraw(); } catch (error) { say(error.message); }
  });
  buttons.append(drop);
  row.append(buttons);
  return row;
}

/** Draws the card. Anything already ticked off sinks below what is still open. */
export async function drawTodos() {
  const target = $("context-todos");
  if (!target) return;
  try {
    const { todos } = await api("todos");
    target.replaceChildren();
    if (!todos.length) {
      target.append(el("p", t("todos.empty"), "context-empty"));
      return;
    }
    for (const entry of todos.slice(0, 40)) target.append(todoRow(entry, drawTodos));
  } catch (error) {
    target.replaceChildren(el("p", error.message, "context-empty"));
  }
}

$("todo-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("todo-text").value.trim();
  if (!text) { say(t("todos.needWords")); return; }
  const local = $("todo-due").value;
  /* The box gives a local time; the app keeps moments, so it is turned into one here. */
  const dueAt = local ? new Date(local).toISOString() : undefined;
  try {
    await api("todos", { text, ...(dueAt ? { dueAt } : {}) });
    $("todo-text").value = "";
    $("todo-due").value = "";
    say("");
    await drawTodos();
  } catch (error) { say(error.message); }
});

/* DG-119: drawn once the window is connected, never before. Asked for before the key was given, the list came back as
   the sign-in's refusal and "Still to do" kept showing it after connecting instead of its own words. */
const workspace = $("workspace");
const connected = () => !workspace || !workspace.hidden;
if (connected()) await drawTodos();
if (workspace) new MutationObserver(() => { if (connected()) void drawTodos(); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
document.addEventListener("branch-language", () => { if (connected()) void drawTodos(); });
