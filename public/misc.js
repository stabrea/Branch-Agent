/**
 * Three small additions from batch 19: a plain-language record of what Branch was allowed to do,
 * added to the bottom of the Usage screen; deciding approvals a kind of thing at a time rather
 * than a tool at a time; and the practice workspace, where nothing is real.
 */
import { t } from "./i18n.js";
const $ = (id) => document.getElementById(id);
const say = (message) => (globalThis.toast ? globalThis.toast(message) : console.warn(message));
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
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
const when = (at) => { try { return new Date(at).toLocaleString(); } catch { return at; } };

/** The bottom of the Usage screen: what Branch was allowed to do, in the order it happened. */
async function renderAllowed() {
  const view = $("usage");
  if (!view || !sessionStorage.getItem("branch-token")) return;
  let record;
  try { record = await api("audit?limit=50"); } catch (e) { say("The record could not be loaded: " + e.message); return; }
  const card = el("article", undefined, "export-card");
  card.append(el("h2", "What the assistant was allowed to do"));
  card.append(el("p", "Every moment that widened or narrowed what Branch could reach: a question you answered, a saved password handed to a command, a change to these settings, a messaging account connected, something exported, or a switch to another project. Nothing here can be changed or removed afterwards, not even by Branch."));

  const busy = record.counts.filter((row) => row.count > 0);
  if (!busy.length) card.append(el("p", "Nothing has happened yet that was worth writing down.", "subtle"));
  const summary = el("ul", undefined, "check-list");
  for (const row of busy) summary.append(el("li", `${row.label} — ${row.count} ${row.count === 1 ? "time" : "times"}`));
  if (busy.length) card.append(summary);

  const list = el("div", undefined, "card-list");
  for (const entry of record.entries.slice(0, 25)) {
    const item = el("div", undefined, "card-list-item");
    item.append(el("strong", entry.reason || entry.action));
    // Where it happened is said plainly when it was somewhere other than this app, and what the
    // task itself came from is said beside it when the two are not the same thing.
    const where = entry.source === "owner" ? "" : ` · on ${entry.source}`;
    const started = entry.origin && entry.origin !== entry.source ? ` · task started by ${entry.origin}` : "";
    item.append(el("p", `${entry.subject || "—"} · ${entry.outcome}${where}${started} · ${when(entry.at)}`, "subtle"));
    list.append(item);
  }
  if (record.entries.length) card.append(list);

  const save = el("button", "Save this as a spreadsheet file");
  save.type = "button";
  save.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = "/api/audit/export.csv";
    link.download = "what-it-was-allowed-to-do.csv";
    link.click();
  });
  card.append(save);
  view.append(card);
}

/**
 * ci-flakes-4: these rows are drawn again by the window's refresh every 3 seconds, and drawing them
 * threw every chooser away and made a new one. An open list shut under the person within three seconds,
 * and the keyboard was thrown out of it. The rows are now made again only when they really changed.
 * (The same cure as public/glass-select.js and public/conversation-mode.js, ci-flakes-2.)
 */
let categoriesDrawn = "";
let categoryFocus = null;
document.addEventListener("focusin", (event) => {
  const select = event.target instanceof HTMLSelectElement && event.target.closest("#approval-categories") ? event.target : null;
  if (select) categoryFocus = select;
  else if (event.target !== document.body && event.target !== document.documentElement) categoryFocus = null;
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("#approval-categories")) categoryFocus = null;
}, true);
const categoriesShape = (categories) =>
  JSON.stringify(categories.map((one) => [one.id, one.label, one.description, one.tools.length, one.decision ?? ""]));
const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function restoreCategoryFocus(select) {
  if (!select?.isConnected || categoryFocus !== select) return;
  await afterPaint();
  const nowhere = document.activeElement === document.body || document.activeElement === document.documentElement;
  if (select.isConnected && categoryFocus === select && nowhere) select.focus({ preventScroll: true });
}

/** Approval settings, a kind of thing at a time: one choice covers every tool of that kind. */
/** A kind's name or sentence in the chosen language; the server's English when there is no translation yet. */
function kindWords(category, part) {
  const key = `toolKinds.kind.${category.id}.${part}`;
  const words = t(key);
  return words === key ? category[part] : words;
}
async function renderCategories() {
  const host = $("approval-categories");
  if (!host || !sessionStorage.getItem("branch-token")) return;
  let view;
  try { view = await api("approvals/categories"); } catch { return; }
  const shape = categoriesShape(view.categories);
  if (shape === categoriesDrawn && host.childElementCount) return;
  categoriesDrawn = shape;
  host.replaceChildren();
  for (const category of view.categories) {
    if (!category.tools.length) continue;
    const row = el("div", undefined, "card-list-item");
    /* The kind's name is the dropdown's name: without it a screen reader announced six identical
       "combo box, Leave as it is" with nothing to tell them apart. (What the choice does is linked
       by public/settings-describe.js, from its "#approval-categories select" row.) */
    const name = el("strong", kindWords(category, "label"));
    name.id = `approval-category-${category.id}-name`;
    row.append(name, el("p", t(category.tools.length === 1 ? "toolKinds.aboutOne" : "toolKinds.aboutMany",
      { about: kindWords(category, "description"), count: category.tools.length }), "subtle"));
    const choice = el("select");
    choice.setAttribute("aria-labelledby", name.id);
    choice.dataset.kind = category.id;
    for (const [value, key] of [["", "toolKinds.leave"], ["allow", "toolKinds.allow"], ["ask", "toolKinds.ask"], ["deny", "toolKinds.deny"]]) {
      const option = el("option", t(key));
      option.value = value;
      choice.append(option);
    }
    choice.value = category.decision ?? "";
    choice.addEventListener("change", async () => {
      if (!choice.value) return;
      try {
        await api("approvals/categories", { [category.id]: choice.value });
        category.decision = choice.value;
        categoriesDrawn = categoriesShape(view.categories);
        say(t("toolKinds.saved", { kind: kindWords(category, "label").toLowerCase(), choice: choice.selectedOptions[0].textContent.toLowerCase() }));
        void window.branchApprovals?.render();
      } catch (e) { say(t("toolKinds.notSaved", { message: e.message })); }
    });
    row.append(choice);
    host.append(row);
  }
}

/** The practice workspace: made-up files to try things on before pointing Branch at real work. */
async function renderPractice() {
  const host = $("practice-state");
  const button = $("practice-toggle");
  const card = $("practice-card");
  if (!host || !button || !card || !sessionStorage.getItem("branch-token")) return;
  let state;
  try { state = await api("practice"); } catch { return; }
  // Offered while someone is still setting up, and kept in view while they are inside it.
  const settingUp = $("first-run") ? !$("first-run").hidden : false;
  card.hidden = !(state.active || settingUp);
  host.textContent = state.active
    ? t("misc.practice.inside")
    : state.exists
      ? t("misc.practice.kept")
      : t("misc.practice.off");
  button.dataset.t = state.active ? "misc.practice.useReal" : "misc.practice.try";
  button.textContent = t(button.dataset.t);
  button.onclick = async () => {
    try {
      await api("practice", { practice: !state.active });
      await renderPractice();
      say(state.active ? "Back in your own folder." : "You are in the practice workspace. Nothing here is real.");
    } catch (e) { say("That could not be done: " + e.message); }
  };
}

/**
 * "Ask me questions first" beside the box you type in. The setting is remembered; the questions
 * themselves are asked when you send, and the answers are written underneath your request.
 */
let askFirstRevision = 0;
let askFirstSaving = false;
async function renderAskFirst() {
  const toggle = $("ask-first-toggle");
  if (!toggle || !sessionStorage.getItem("branch-token")) return;
  const revision = askFirstRevision;
  let view;
  try { view = await api("ask-first/settings"); } catch { return; }
  if (!askFirstSaving && revision === askFirstRevision) toggle.checked = view.askFirst === true;
  if (toggle.dataset.wired === "yes") return;
  toggle.dataset.wired = "yes";
  toggle.addEventListener("change", async () => {
    const wanted = toggle.checked, saving = ++askFirstRevision;
    askFirstSaving = true;
    try { await api("ask-first/settings", { askFirst: wanted }); }
    catch (e) {
      say("That could not be saved: " + e.message);
      if (saving === askFirstRevision) toggle.checked = !wanted;
    } finally {
      if (saving === askFirstRevision) { askFirstSaving = false; askFirstRevision++; }
    }
  });
}

/**
 * The questions to put to the person before a task starts, and their request with the answers
 * written underneath it. Returns the original request when there was nothing worth asking.
 */
async function askBeforeStarting(prompt) {
  let outcome;
  try { outcome = await api("ask-first", { prompt }); } catch { return prompt; }
  if (outcome.skipped || !outcome.questions.length) return prompt;
  const answers = outcome.questions.map((question) => ({
    question: question.question,
    answer: (globalThis.prompt(`${question.question}\n\nLeave this blank and it will assume: ${question.suggested || "nothing in particular"}`) ?? "").trim(),
  }));
  try { return (await api("ask-first/answers", { prompt, answers })).prompt; } catch { return prompt; }
}

/** Everything on this file's screens. Safe to call again at any time. */
async function render() {
  const focusedCategory = categoryFocus?.isConnected ? categoryFocus : null;
  await Promise.allSettled([renderCategories(), renderPractice(), renderAskFirst()]);
  await restoreCategoryFocus(focusedCategory);
}
window.branchAllowed = { render: renderAllowed };
window.branchMisc = { render, askBeforeStarting };
/** The kind of tool the keyboard is on right now, or null when it is somewhere else entirely. */
function focusedKind() {
  const node = document.activeElement;
  return node instanceof HTMLSelectElement && node.closest("#approval-categories") ? node.dataset.kind ?? null : null;
}

/**
 * Puts the keyboard back on the same kind after the list has been thrown away and made again.
 * restoreCategoryFocus above cannot do this: it holds the old node, and a redraw detaches it, so the
 * kind is found again by its id. Only when the redraw left the focus nowhere -- never take it from
 * wherever the person actually is, which in this flow is the language they just chose.
 */
function refocusKind(kind) {
  if (!kind) return;
  if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
  for (const select of document.querySelectorAll("#approval-categories select"))
    if (select.dataset.kind === kind) { select.focus({ preventScroll: true }); return; }
}

/* The kinds are only redrawn when they change; a change of language must redraw them in the new words. */
document.addEventListener("branch-language", () => {
  const kind = focusedKind();
  categoriesDrawn = "";
  void renderCategories().then(() => refocusKind(kind));
});
