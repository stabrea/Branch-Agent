/**
 * R17-049: under the meter's numbers, one bar per model round of this conversation: what went in
 * (the part the service's cache served drawn in its own colour), what came out, and a mark where
 * the conversation was folded into a summary. A line says how close the latest round is to the next
 * fold, and while a fold is being written it says so. Shown only with the Appearance switch on.
 *
 * The figures come from /api/model-savings/rounds; nothing is counted here. KeepOak tokens only.
 */
import { t, formatNumber } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const svgNs = "http://www.w3.org/2000/svg";
let on = false;
/** Kept here because the meter's redraw takes it out of the page for a moment. */
let chartBox = null;

async function get(path) {
  const response = await fetch("/api/" + path, { headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function keyed(tag, key, values, className) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function rect(x, y, width, height, fill) {
  const node = document.createElementNS(svgNs, "rect");
  for (const [name, value] of Object.entries({ x, y, width, height })) node.setAttribute(name, String(Math.max(0, value)));
  node.style.fill = fill;
  return node;
}

/** The bars. Each round is a column: cached input at the foot, the rest of the input, then the answer.
    A round whose service never said how much came from the cache (`cached` is null) draws its input
    faded, so the chart never shows a cache share nobody reported. */
function bars(data) {
  const width = 320, height = 96, rounds = data.rounds;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", "round-chart-summary");
  svg.classList.add("round-chart-bars");
  const most = Math.max(1, ...rounds.map((row) => row.input + row.output));
  const step = width / Math.max(rounds.length, 1), barWidth = Math.max(2, step - 2);
  rounds.forEach((row, at) => {
    const x = at * step, scale = (value) => (value / most) * height;
    const unreported = row.cached === null || row.cached === undefined;
    const cached = unreported ? 0 : Math.min(row.cached, row.input);
    let y = height;
    for (const [value, colour, part] of [[cached, "var(--good)", "cached"], [row.input - cached, "var(--copper)", "input"], [row.output, "var(--muted)", "output"]]) {
      const tall = scale(value);
      y -= tall;
      if (tall <= 0) continue;
      const bar = rect(x, y, barWidth, tall, colour);
      if (unreported && part === "input") bar.classList.add("round-chart-unreported");
      svg.append(bar);
    }
  });
  for (const fold of data.folds) {
    const mark = rect(fold.afterRound * step - 1, 0, 2, height, fold.done ? "var(--line-strong)" : "var(--accent)");
    mark.classList.add("round-chart-fold");
    svg.append(mark);
  }
  return svg;
}

function legend() {
  const row = document.createElement("div");
  row.className = "round-chart-legend";
  for (const [key, colour] of [["chart.cached", "var(--good)"], ["chart.input", "var(--copper)"], ["chart.output", "var(--muted)"], ["chart.fold", "var(--line-strong)"]]) {
    const item = keyed("span", `savings.${key}`);
    const swatch = document.createElement("i");
    swatch.style.background = colour;
    item.prepend(swatch);
    row.append(item);
  }
  return row;
}

function paint(box, data) {
  const reported = data.rounds.filter((row) => row.cached !== null && row.cached !== undefined);
  const cached = reported.reduce((sum, row) => sum + row.cached, 0);
  const input = data.rounds.reduce((sum, row) => sum + row.input, 0);
  const unknown = data.rounds.length - reported.length;
  // A cache nobody reported is said to be unknown, never counted as none.
  const key = !unknown ? "savings.chart.summary" : reported.length ? "savings.chart.summary-some" : "savings.chart.summary-unreported";
  const summary = keyed("p", key, {
    rounds: formatNumber(data.rounds.length), input: formatNumber(input), cached: formatNumber(cached),
    unknown: formatNumber(unknown), folds: formatNumber(data.folds.length),
  }, "subtle");
  summary.id = "round-chart-summary";
  const parts = [keyed("h3", "savings.chart.title"), summary];
  if (data.rounds.length) parts.push(bars(data), legend());
  if (data.folding) parts.push(keyed("p", "savings.chart.folding", undefined, "field-note"));
  else if (data.towardsFold !== null) parts.push(keyed("p", "savings.chart.towards", { percent: formatNumber(data.towardsFold) }, "subtle"));
  box.replaceChildren(...parts);
}

function holder() {
  const popover = $("meter-popover");
  if (!popover) return null;
  if (!chartBox) {
    chartBox = document.createElement("section");
    chartBox.id = "round-chart";
    chartBox.className = "round-chart";
    chartBox.setAttribute("aria-live", "polite");
  }
  if (!popover.contains(chartBox)) popover.append(chartBox);
  return chartBox;
}

async function refresh() {
  const popover = $("meter-popover"), session = $("conversation")?.dataset.sessionId;
  const box = on ? holder() : chartBox;
  if (!box) return;
  box.hidden = !on || !popover || popover.hidden || !session;
  if (box.hidden) return;
  try { paint(box, await get(`model-savings/rounds?session=${encodeURIComponent(session)}`)); }
  catch { /* the chart keeps what it last showed */ }
}

if (typeof document !== "undefined") {
  document.addEventListener("branch-model-savings", (event) => {
    on = event.detail?.values?.roundChart?.mode === "on";
    void refresh();
  });
  const popover = $("meter-popover");
  if (popover) {
    new MutationObserver(() => void refresh()).observe(popover, { attributes: true, attributeFilter: ["hidden"] });
    // The meter redraws its numbers by replacing the popover's contents; the chart goes back at the end.
    new MutationObserver(() => { if (on && chartBox && !popover.contains(chartBox)) popover.append(chartBox); })
      .observe(popover, { childList: true });
  }
  document.addEventListener("branch-language", () => void refresh());
  setInterval(() => { if (on) void refresh(); }, 4000);
  window.branchRoundChart = { refresh };
}
