/**
 * Two small additions. In Documents: ask a question of one file, or hold two files up against each
 * other. In Memory: one button that runs every tidying check at once and says plainly how the saved
 * facts are made up. Nothing here removes anything; tidying only ever makes suggestions.
 */
import { t } from "./i18n.js";
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const short = (text, max = 120) => (String(text).length > max ? String(text).slice(0, max - 1) + "…" : String(text));

/** Asks a question of one file in the workspace and shows the answer with where it came from. */
async function askDocument() {
  const file = $("document-ask-file").value.trim(), question = $("document-ask-question").value.trim();
  const out = $("document-ask-result");
  if (!file || !question) { out.textContent = t("docs.status.fileAndQuestion"); return; }
  out.textContent = t("docs.status.reading");
  try {
    const result = await api("tools/try", { name: "documents.analyse", input: { file, question } });
    const answer = result.result ?? result;
    out.replaceChildren(el("p", answer.answer ?? "Nothing came back."));
    for (const limit of answer.limits ?? []) out.append(el("p", limit, "subtle"));
    for (const table of answer.tables ?? [])
      out.append(el("p", `Opened the table "${table.name}" (${table.rows} rows) so you can ask about the figures.`, "meta"));
  } catch (error) { out.textContent = error.message; }
}
/** Says in plain language what changed between two files. */
async function compareDocuments() {
  const file = $("document-compare-a").value.trim(), against = $("document-compare-b").value.trim();
  const out = $("document-compare-result");
  if (!file || !against) { out.textContent = t("docs.status.bothFiles"); return; }
  out.textContent = t("docs.status.comparing");
  try {
    const result = await api("tools/try", { name: "documents.compare", input: { file, against } });
    const answer = result.result ?? result;
    out.replaceChildren(el("p", answer.summary ?? "Nothing came back."));
    const changed = { added: "added", removed: "taken out", changed: "reworded" };
    for (const change of answer.changes ?? [])
      out.append(el("p", `${change.section}: ${changed[change.change] ?? change.change}`, "meta"));
    out.append(el("p", `${answer.unchanged ?? 0} section(s) are the same in both.`, "subtle"));
  } catch (error) { out.textContent = error.message; }
}

/** Every tidying check at once, with the counts behind them. Nothing is changed. */
async function tidyEverything(stage) {
  const out = $("memory-tidy-all-result");
  out.textContent = stage ? t("docs.status.suggesting") : t("docs.status.looking");
  try {
    const report = stage ? await api("memory/tidy/all", { stage: true }) : await api("memory/tidy/all");
    out.replaceChildren();
    const groups = [
      ["The same thing saved more than once", report.duplicates.map((group) => group.texts.map((text) => short(text, 60)).join(" / "))],
      ["A newer fact disagrees with an older one", report.contradictions.map((pair) => `${short(pair.newer.text, 60)} — was: ${short(pair.older.text, 60)}`)],
      ["Not touched in a long time", report.stale.map((entry) => `${short(entry.text)} — ${entry.reason}`)],
      ["Never used since it was saved", report.neverUsed.map((entry) => short(entry.text))],
      // The one group the owner can act on here: a leftover note can be kept instead of set aside.
      ["Notes left over from a job", report.leftoverScratch.map((entry) => short(entry.text)), report.leftoverScratch],
    ];
    for (const [title, lines, keepable] of groups) {
      if (!lines.length) continue;
      const card = el("div", undefined, "card");
      card.append(el("strong", `${title} (${lines.length})`));
      lines.forEach((line, index) => {
        const row = el("p", line, "meta");
        if (keepable?.[index]) row.append(" ", keepButton(keepable[index].id, row));
        card.append(row);
      });
      out.append(card);
    }
    if (!out.childElementCount) out.append(el("p", "Nothing to tidy up. Your saved facts look fine.", "meta"));
    out.append(el("p", healthLine(report.health), "subtle"));
    if (stage) out.append(el("p",
      report.staged.length
        ? `Added ${report.staged.length} suggestion(s). Accept or reject them under “What it learns”. Nothing was removed.`
        : "Nothing new to suggest.", "meta"));
  } catch (error) { out.textContent = error.message; }
}
/** Keeps one note made during a job for good, so finishing a job no longer clears it. */
function keepButton(id, row) {
  const button = el("button", "Keep this", "small");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`memory/${id}/keep`, {});
      button.replaceWith(el("span", " Kept for good.", "subtle"));
    } catch (error) {
      button.disabled = false;
      row.append(el("span", ` ${error.message}`, "subtle"));
    }
  });
  return button;
}
/** One sentence about how the saved facts are made up: counts only, never their wording. */
function healthLine(health) {
  if (!health) return "";
  const kinds = Object.entries(health.byKind ?? {}).map(([kind, count]) => `${count} ${kind.replace(/-/g, " ")}`).join(", ");
  return `${health.facts} facts saved of ${health.capacity.maxFacts} allowed${kinds ? ` (${kinds})` : ""}. `
    + `${health.neverUsed} have never been used, ${health.taskScratch} are notes from a job, and ${health.archived} are set aside.`;
}

export function setUpDocsMemory2() {
  if ($("document-ask-card")) {
    $("document-ask-go").addEventListener("click", askDocument);
    $("document-compare-go").addEventListener("click", compareDocuments);
  }
  if ($("memory-tidy-all-card")) {
    $("memory-tidy-all-look").addEventListener("click", () => tidyEverything(false));
    $("memory-tidy-all-suggest").addEventListener("click", () => tidyEverything(true));
  }
}
setUpDocsMemory2();
