/**
 * The quiet meter under the composer: how much of this conversation's room the assistant has used
 * so far, and roughly what it has cost. Clicking it opens the numbers behind the bar. It never
 * shows a cost of nothing for a model with no price on file — it says so in words instead.
 */
import { t, formatNumber } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path) {
  const response = await fetch("/api/" + path, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
/* A sensible room to measure against until the workspace says otherwise. */
const DEFAULT_BUDGET = 128000;
let stats = { messages: 0, runs: 0, input: 0, output: 0, cost: null, budget: DEFAULT_BUDGET };

const session = () => $("conversation").dataset.sessionId || null;
/** Money in words, matching the Usage screen; null means nobody knows. */
const money = (value) =>
  value === null || value === undefined ? t("meter.noPrice")
    : value > 0 && value < 0.01 ? "< $0.01"
      : "$" + (value < 1 ? value.toFixed(4) : value.toFixed(2));

/** Adds up every task in this conversation: how much went in and out, and what it probably cost. */
function totals(state, here) {
  const mine = (state.runs ?? []).filter((run) => run.sessionId === here);
  let input = 0, output = 0, cost = null;
  for (const run of mine) {
    input += (run.usage?.reportedInput || run.usage?.estimatedInput || 0);
    output += (run.usage?.reportedOutput || run.usage?.estimatedOutput || 0);
    if (typeof run.cost?.amount === "number") cost = (cost ?? 0) + run.cost.amount;
  }
  return { messages: $("conversation").querySelectorAll(".message").length, runs: mine.length, input, output, cost };
}
function paint() {
  const used = stats.input + stats.output;
  const share = Math.max(0, Math.min(1, used / (stats.budget || DEFAULT_BUDGET)));
  $("meter-fill").style.width = `${Math.round(share * 100)}%`;
  $("meter-button").setAttribute("aria-label", t("meter.of", { used: formatNumber(used), budget: formatNumber(stats.budget) }));
  $("meter-text").textContent = t("meter.of", { used: formatNumber(used), budget: formatNumber(stats.budget) });
  /* The price shows only when one is known. With no price on file the line under the box says
     nothing about money (never "about nothing so far"); the numbers behind the meter still say so. */
  $("meter-cost").textContent = stats.cost === null || stats.cost === undefined
    ? ""
    : t("meter.cost", { cost: money(stats.cost) });
  $("meter-row").hidden = false;
  $("meter-row").dataset.share = String(Math.round(share * 100));
}
/** The numbers behind the bar, for anyone who wants them. */
function paintPopover() {
  const box = $("meter-popover");
  const rows = [
    [t("meter.messages"), formatNumber(stats.messages)],
    [t("meter.runs"), formatNumber(stats.runs)],
    [t("meter.tokensIn"), formatNumber(stats.input)],
    [t("meter.tokensOut"), formatNumber(stats.output)],
    [stats.cost === null || stats.cost === undefined ? t("meter.noCost") : t("meter.cost", { cost: money(stats.cost) }), ""],
  ];
  box.replaceChildren(el("h3", t("meter.stats")));
  for (const [label, value] of rows) {
    const row = el("div", undefined, "meter-stat");
    row.append(el("span", label));
    if (value) row.append(el("strong", value));
    box.append(row);
  }
}
/** Refreshes the meter from the workspace state; safe to call as often as you like. */
export async function refreshMeter() {
  if ($("workspace").hidden) return;
  const here = session();
  if (!here) {
    stats = { ...stats, messages: 0, runs: 0, input: 0, output: 0, cost: null };
    paint();
    return;
  }
  try {
    const state = await api("state");
    const budget = Number(state.models?.contextWindow ?? state.contextWindow ?? 0) || DEFAULT_BUDGET;
    stats = { ...totals(state, here), budget };
    paint();
    if (!$("meter-popover").hidden) paintPopover();
  } catch { /* the meter keeps what it last showed */ }
}
$("meter-button").addEventListener("click", () => {
  const box = $("meter-popover");
  box.hidden = !box.hidden;
  $("meter-button").setAttribute("aria-expanded", String(!box.hidden));
  if (!box.hidden) paintPopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("meter-popover").hidden) $("meter-button").click();
});
setInterval(() => void refreshMeter(), 6000);
new MutationObserver(() => void refreshMeter()).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
void refreshMeter();
globalThis.branchTokenMeter = { refresh: refreshMeter };
