/**
 * The learning core's card (src/fly-core): the three-way switch, what Branch has learned in plain
 * words with how many tasks each habit rests on, and forgetting all of it.
 *
 * It lives in Library → Memory (`docs/places.md`: what the assistant knows), beside the queue of
 * suggestions its skill ideas arrive in. The switch saves as soon as it moves; the one filled button
 * is "Forget what it learned", and it asks first.
 *
 * It also opens the skill editor on a draft when the owner accepts one of the core's skill ideas:
 * `globalThis.branchOpenSkillDraft(draft)` is called by the suggestion queue in app.js.
 */
import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const keyed = (tag, key, className) => {
  const node = el(tag, t(key), className);
  node.dataset.t = key;
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

const positions = [
  ["off", "field.switch-off"],
  ["when-needed", "field.switch-when-needed"],
  ["on", "field.switch-on"],
];

function switchControl(mode, status, redraw) {
  const label = keyed("label", "field.learning-core-switch");
  label.htmlFor = "learning-core-mode";
  const select = el("select");
  select.id = "learning-core-mode";
  for (const [value, key] of positions) {
    const option = keyed("option", key);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      redraw(await api("learning-core/settings", { mode: select.value }), "settings.learning-core.saved");
    } catch (error) {
      status.textContent = error.message;
      select.disabled = false;
    }
  });
  return [label, select, keyed("p", "settings.note.learning-core-modes", "field-note")];
}

/** One habit as a sentence: what it is, how it tended to go, and how many tasks that rests on. */
function habitLine(habit) {
  const key = `settings.learning-core.habit-${habit.leaning}`;
  const line = el("li", t(key, { kind: t(`settings.learning-core.kind-${habit.kind}`), name: habit.name, count: habit.uses }));
  line.dataset.leaning = habit.leaning;
  return line;
}

function learnedList(view) {
  const heading = keyed("p", "settings.learning-core.learned", "learning-core-heading");
  if (!view.habits.length) return [heading, keyed("p", "settings.learning-core.empty", "empty-state")];
  const list = el("ul", undefined, "learning-core-habits");
  list.id = "learning-core-habits";
  list.append(...view.habits.map(habitLine));
  const kept = el("p", t("settings.learning-core.kept", { count: view.kept.actions }), "field-note");
  return [heading, list, kept];
}

function forgetButton(status, redraw) {
  const button = keyed("button", "action.forget-what-it-learned");
  button.type = "button";
  button.id = "learning-core-forget";
  button.addEventListener("click", async () => {
    if (!globalThis.confirm(t("settings.learning-core.confirm"))) return;
    button.disabled = true;
    try {
      redraw(await api("learning-core/forget", { confirm: "forget" }), "settings.learning-core.forgotten");
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
  return button;
}

function buildCard(view, message) {
  const card = el("section", undefined, "card");
  card.id = "learning-core";
  card.dataset.home = "library:memory";
  const status = el("p", message ? t(message) : "", "meta");
  status.setAttribute("role", "status");
  if (message) status.dataset.t = message;
  const redraw = (next, note) => {
    card.replaceWith(buildCard(next, note));
    document.getElementById("learning-core-mode")?.focus();
  };
  card.append(
    keyed("h2", "settings.card.learning-core"),
    keyed("p", "settings.note.learning-core"),
    ...switchControl(view.settings.mode, status, redraw),
    ...learnedList(view),
    keyed("p", "settings.note.learning-core-forget", "subtle"),
    forgetButton(status, redraw),
    status,
  );
  return card;
}

export async function drawLearningCore() {
  let view;
  try { view = await api("learning-core"); } catch { return; }
  const existing = document.getElementById("learning-core");
  const card = buildCard(view);
  if (existing) existing.replaceWith(card); else document.body.append(card);
}

/** Opens the existing skill editor on a draft made from steps that kept working. Nothing is installed. */
export function openSkillDraft(draft) {
  if (!draft?.document) return false;
  globalThis.branchLayout?.go?.("skills");
  document.getElementById("skill-new")?.click();
  const editor = document.getElementById("skill-document");
  if (!editor) return false;
  editor.value = draft.document;
  const status = document.getElementById("skill-status");
  if (status) status.textContent = t("settings.learning-core.draft-opened");
  editor.focus();
  return true;
}

if (typeof document !== "undefined") {
  globalThis.branchOpenSkillDraft = openSkillDraft;
  globalThis.branchLearningCoreReady = () => { drawLearningCore().catch(() => {}); };
  /* The habit lines are assembled from names and counts, so they are drawn again in the new language. */
  document.addEventListener("branch-language", () => { drawLearningCore().catch(() => {}); });
  drawLearningCore().catch(() => {});
}
