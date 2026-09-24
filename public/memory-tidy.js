/**
 * Keeping saved facts tidy, and moving them in and out. Everything this panel finds becomes a
 * suggestion under "What it learns"; nothing is removed here. Kept in its own file; the page only
 * provides the empty section.
 */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function say(message) {
  $("memory-tidy-status").textContent = message;
}
const short = (text, max = 90) => (String(text).length > max ? String(text).slice(0, max - 1) + "…" : String(text));

/** What the assistant can do with the words in a fact and, when a model allows it, its meaning. */
async function drawSettings() {
  const view = await api("memory/retrieval");
  $("memory-meaning").checked = view.settings.useEmbeddings;
  $("memory-meaning-note").textContent = view.meaningSearch
    ? t("memory.meaning.on")
    : view.settings.useEmbeddings
      ? t("memory.meaning.cannot")
      : t("memory.meaning.off");
  $("memory-index").disabled = !view.meaningSearch;
}
function rows(group) {
  const list = $("memory-tidy-list");
  list.replaceChildren();
  for (const entry of group) {
    const node = el("div", undefined, "card");
    node.append(el("strong", entry.title), el("p", entry.detail, "meta"));
    list.append(node);
  }
  if (!group.length) list.append(el("p", "Nothing to tidy up. Your saved facts look fine.", "meta"));
}
/** Reads what looks wrong without changing anything. */
async function look() {
  try {
    const review = await api("memory/tidy");
    rows([
      ...review.duplicates.map((group) => ({
        title: "The same thing saved more than once",
        detail: `${group.texts.length} facts: ${group.texts.map((text) => short(text, 50)).join(" / ")}`,
      })),
      ...review.contradictions.map((pair) => ({
        title: "A newer fact disagrees with an older one",
        detail: `Newer: ${short(pair.newer.text)} — older: ${short(pair.older.text)}`,
      })),
      ...review.leastUseful.map((candidate) => ({
        title: "Rarely used, and memory is nearly full",
        detail: `${short(candidate.text)} — used ${candidate.uses} time(s)`,
      })),
    ]);
    say(`${review.capacity.count} of ${review.capacity.maxFacts} facts saved.`);
  } catch (error) { say(error.message); }
}
/** Turns what it found into suggestions the owner accepts or rejects under "What it learns". */
async function suggest() {
  try {
    const result = await api("memory/tidy", {});
    say(result.suggested
      ? `Added ${result.suggested} suggestion(s). Accept or reject them under "What it learns".`
      : "Nothing new to suggest.");
    await look();
  } catch (error) { say(error.message); }
}
async function indexByMeaning() {
  say("Comparing your facts by meaning…");
  try {
    const result = await api("memory/index", {});
    say(result.embedded ? `${result.embedded} fact(s) can now be matched by meaning.` : result.reason);
  } catch (error) { say(error.message); }
}
async function saveSettings() {
  try {
    await api("memory/retrieval", { useEmbeddings: $("memory-meaning").checked });
    await drawSettings();
    toast("Saved.");
  } catch (error) { say(error.message); }
}
/** Facts leave as one line each, which is what other assistants read and write. */
async function exportLines() {
  const response = await fetch("/api/memory/export?format=jsonl", {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  if (!response.ok) { say("The facts could not be saved to a file."); return; }
  const url = URL.createObjectURL(new Blob([await response.text()], { type: "application/jsonl" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "memory.jsonl" });
  link.click();
  URL.revokeObjectURL(url);
  say("Saved to memory.jsonl.");
}
async function importLines(file) {
  if (!file) return;
  try {
    const report = await api("memory/import", { jsonl: await file.text() });
    say(`Added ${report.imported}. Already saved: ${report.duplicates + report.unchanged}. Unreadable lines: ${report.skipped.length}.`);
  } catch (error) { say(error.message); }
}

export function setUpMemoryTidy() {
  if (!$("memory-tidy-card")) return;
  $("memory-tidy-look").addEventListener("click", look);
  $("memory-tidy-suggest").addEventListener("click", suggest);
  $("memory-index").addEventListener("click", indexByMeaning);
  $("memory-meaning").addEventListener("change", saveSettings);
  $("memory-jsonl-export").addEventListener("click", exportLines);
  $("memory-jsonl-import").addEventListener("click", () => $("memory-jsonl-file").click());
  $("memory-jsonl-file").addEventListener("change", (event) => importLines(event.target.files?.[0]));
  drawSettings().catch(() => say("Sign in to tidy up your saved facts."));
}
setUpMemoryTidy();
