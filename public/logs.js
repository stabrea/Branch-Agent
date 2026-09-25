/**
 * The record, under Activity: every step every task took, narrowed down by the kind of step, by the
 * task, or by when it happened, and saved as a file of one line each. Under Usage, two readings of
 * things the app already writes down: how busy each model connection is beside the allowance that
 * service reports, and every round answered from the kept-answers store with what it would
 * otherwise have cost.
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
const say = (id, message) => { const box = $(id); if (box) box.textContent = message; };

/** What the boxes on the card say, as the question the route expects. */
function filterNow() {
  const since = $("log-since")?.value;
  const parts = new URLSearchParams();
  if ($("log-kind")?.value) parts.set("kind", $("log-kind").value);
  if ($("log-run")?.value.trim()) parts.set("runId", $("log-run").value.trim());
  if (since) parts.set("since", new Date(since).toISOString());
  parts.set("limit", "200");
  return parts.toString();
}

/**
 * Dogfood E2 part 2 (Mac mini's item 3): a kind of step in words ("Asked you first"), not as it is filed
 * ("policy.ask"). A kind with no words of its own is spelled out from its name, so a new one still reads.
 */
export function kindWords(kind) {
  const said = t(`logs.kind.${kind}`);
  if (said !== `logs.kind.${kind}`) return said;
  const words = String(kind).replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** The one sentence a step already has about itself (a tool's label, a question), if it has one. */
const sentenceOf = (detail) => [detail.label, detail.question, detail.summary, detail.reason].find((value) => typeof value === "string" && value.trim());

/** One line of the record: when, what kind of step, which task, what it said, and its details folded away. */
function logRow(line) {
  const row = el("article", undefined, "card-row log-row");
  row.dataset.kind = line.kind;
  row.append(el("strong", kindWords(line.kind)));
  row.append(el("span", `${formatDate(line.at)} · ${t("logs.task", { id: line.runId.slice(0, 8) })}`, "meta"));
  const sentence = sentenceOf(line.detail);
  if (sentence) row.append(el("p", sentence.slice(0, 300)));
  const detail = Object.entries(line.detail).map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
  if (detail) {
    const more = el("details", undefined, "log-details");
    more.append(el("summary", t("logs.details")), el("p", `${line.kind} · ${detail.slice(0, 400)}`, "meta"));
    row.append(more);
  }
  return row;
}

export async function drawLog() {
  const list = $("log-list");
  if (!list) return;
  try {
    const { lines, kinds } = await api("log?" + filterNow());
    fillKinds(kinds);
    list.replaceChildren();
    if (!lines.length) { list.append(el("p", t("logs.empty"), "meta")); say("log-status", ""); return; }
    for (const line of lines) list.append(logRow(line));
    say("log-status", t("logs.count", { count: lines.length }));
  } catch (error) { say("log-status", error.message); }
}
/** The kinds of step actually on file, so the picker never offers one that finds nothing. */
function fillKinds(kinds) {
  const picker = $("log-kind");
  if (!picker || picker.dataset.filled === String(kinds.length)) return;
  const chosen = picker.value;
  picker.replaceChildren(new Option(t("logs.anyKind"), ""));
  for (const kind of kinds) picker.append(new Option(kindWords(kind), kind));
  picker.value = chosen;
  picker.dataset.filled = String(kinds.length);
}

/** Saves what is on screen as a file of one line each, which is the shape a log file has. */
async function exportLog() {
  try {
    const saved = await api("log/export?" + filterNow());
    const blob = new Blob([saved.body], { type: saved.contentType });
    const address = URL.createObjectURL(blob);
    const link = el("a");
    link.href = address;
    link.download = saved.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(address), 10000);
    say("log-status", t("logs.saved", { count: saved.lines }));
  } catch (error) { say("log-status", error.message); }
}

/** A card with a title, because every card on every screen carries one. */
function card(view, title, intro) {
  const node = el("article", undefined, "card");
  node.append(el("h2", title));
  if (intro) node.append(el("p", intro, "meta"));
  const list = el("div", undefined, "card-list");
  node.append(list);
  view.append(node);
  return list;
}

/** How busy each connection is, beside the allowance the service itself reports. */
async function drawRequestRates(view) {
  const list = card(view, t("rates.title"), t("rates.intro"));
  try {
    const { connections } = await api("request-rates");
    if (!connections.length) { list.append(el("p", t("rates.empty"), "meta")); return; }
    for (const row of connections) {
      const line = el("article", undefined, "card-row");
      line.append(el("strong", row.connection), el("span", row.summary, "meta"));
      list.append(line);
    }
  } catch (error) { list.replaceChildren(el("p", error.message, "meta")); }
}

/** Every round answered out of the kept answers, and what it would otherwise have cost. */
async function drawCachedAnswers(view) {
  const list = card(view, t("cached.title"), t("cached.intro"));
  try {
    const { lines, wouldHaveCost } = await api("cached-answers");
    if (!lines.length) { list.append(el("p", t("cached.empty"), "meta")); return; }
    list.append(el("p", t("cached.total", { amount: wouldHaveCost.toFixed(4) }), "meta"));
    for (const line of lines.slice(0, 40)) {
      const row = el("article", undefined, "card-row");
      row.append(el("strong", line.model || "a model"));
      row.append(el("span", `${formatDate(line.at)} · would have cost $${line.wouldHaveCost.toFixed(4)} `
        + `(${line.savedInput} in, ${line.savedOutput} out)`, "meta"));
      list.append(row);
    }
  } catch (error) { list.replaceChildren(el("p", error.message, "meta")); }
}

/** Every set of questions handed over at once, and what handing it over saved. */
async function drawBatchSets(view) {
  const list = card(view, t("batchsets.title"), t("batchsets.intro"));
  try {
    const { lines, saved, batched, askedAgain } = await api("batch-sets");
    if (!lines.length) { list.append(el("p", t("batchsets.empty"), "meta")); return; }
    list.append(el("p", t("batchsets.total", { amount: saved.toFixed(4), batched, again: askedAgain }), "meta"));
    for (const line of lines.slice(0, 40)) {
      const row = el("article", undefined, "card-row");
      row.append(el("strong", line.model || "a model"));
      row.append(el("span", `${formatDate(line.at)} · `
        + (line.route === "batch"
          ? t("batchsets.row.batch", { batched: line.batched, questions: line.questions, amount: line.saved.toFixed(4) })
          : t("batchsets.row.direct", { questions: line.questions })), "meta"));
      if (line.askedAgain || line.unanswered)
        row.append(el("span", t("batchsets.row.gaps", { again: line.askedAgain, lost: line.unanswered }), "meta"));
      if (line.reason) row.append(el("span", line.reason, "meta"));
      list.append(row);
    }
  } catch (error) { list.replaceChildren(el("p", error.message, "meta")); }
}

/** The Usage screen asks for these at the end of its own render. */
globalThis.branchDashboards = {
  async renderInto(view) {
    await drawRequestRates(view);
    await drawCachedAnswers(view);
    await drawBatchSets(view);
  },
};

$("log-refresh")?.addEventListener("click", () => { void drawLog(); });
$("log-export")?.addEventListener("click", () => { void exportLog(); });
document.querySelector('[data-view="runs"]')?.addEventListener("click", () => { void drawLog(); });
