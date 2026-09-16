/**
 * Two tasks side by side. Pick one on the Activity screen, pick another, and see what each of them
 * cost, how long it took, how many rounds and tools it used — and the difference between the two
 * answers, line by line. Everything here is read from the same "Look inside" answer the inspector
 * uses; nothing new is worked out.
 */
import { t, formatNumber, formatDate } from "/i18n.js";

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

/** The tasks chosen so far, oldest choice first. Two is the most it will hold. */
let chosen = [];

/** The figures one task is summed up by, all of them read off its own record. */
function figures(view) {
  const tokens = view.rounds.reduce(
    (total, round) => ({ input: total.input + (round.tokens.input ?? 0), output: total.output + (round.tokens.output ?? 0) }),
    { input: 0, output: 0 },
  );
  const cost = view.rounds.reduce((total, round) => (round.cost?.amount === null || round.cost?.amount === undefined ? total : total + round.cost.amount), null);
  return {
    when: formatDate(view.run?.createdAt ?? Date.now()),
    status: view.run?.status ?? "unknown",
    seconds: view.seconds,
    rounds: view.rounds.length,
    tools: view.calls.length,
    toolsFailed: view.calls.filter((call) => call.status === "failed").length,
    tokens,
    cost,
    answer: view.run?.output ?? "",
    prompt: view.run?.prompt ?? "",
  };
}
/** Money in words; nobody knows is said as nobody knows, never as nothing. */
const money = (value) => (value === null || value === undefined ? "no price on file"
  : value > 0 && value < 0.01 ? "less than $0.01" : "$" + (value < 1 ? value.toFixed(4) : value.toFixed(2)));

/** One row of the table: the label, then the same figure from each task. */
function row(body, label, left, right) {
  const line = body.insertRow();
  line.insertCell().textContent = label;
  line.insertCell().textContent = String(left);
  line.insertCell().textContent = String(right);
  if (String(left) !== String(right)) line.classList.add("compare-differs");
  return line;
}

function table(a, b) {
  const node = document.createElement("table");
  node.className = "compare-table";
  const head = node.createTHead().insertRow();
  for (const cell of ["", "First task", "Second task"]) head.append(el("th", cell));
  const body = node.createTBody();
  row(body, "When", a.when, b.when);
  row(body, "How it ended", a.status, b.status);
  row(body, "How long", a.seconds === null ? "—" : `${formatNumber(a.seconds)}s`, b.seconds === null ? "—" : `${formatNumber(b.seconds)}s`);
  row(body, "Rounds with the model", a.rounds, b.rounds);
  row(body, "Tools used", a.tools, b.tools);
  row(body, "Tools that did not work", a.toolsFailed, b.toolsFailed);
  row(body, "Words in (tokens)", formatNumber(a.tokens.input), formatNumber(b.tokens.input));
  row(body, "Words out (tokens)", formatNumber(a.tokens.output), formatNumber(b.tokens.output));
  row(body, "Estimated cost", money(a.cost), money(b.cost));
  return node;
}

/**
 * The difference between the two answers, line by line. This is the plainest comparison there is:
 * a line in one and not the other is marked, and a line in both is left alone. It is enough to see
 * what changed without pretending to be a proper diff tool.
 */
function answerDiff(left, right) {
  const box = el("div", undefined, "compare-diff");
  const a = left.split("\n"), b = right.split("\n");
  if (left === right) {
    box.append(el("p", t("activity.compareSame"), "meta"));
    return box;
  }
  const inB = new Set(b), inA = new Set(a);
  const seen = new Set();
  for (const line of a) {
    if (inB.has(line) || seen.has("-" + line)) continue;
    seen.add("-" + line);
    box.append(el("p", "− " + line, "compare-gone"));
  }
  for (const line of b) {
    if (inA.has(line) || seen.has("+" + line)) continue;
    seen.add("+" + line);
    box.append(el("p", "+ " + line, "compare-new"));
  }
  if (!box.children.length) box.append(el("p", t("activity.compareSame"), "meta"));
  return box;
}

function close() {
  chosen = [];
  const panel = $("compare-panel");
  panel.hidden = true;
  panel.replaceChildren();
  for (const node of document.querySelectorAll(".compare-pick[aria-pressed='true']")) node.setAttribute("aria-pressed", "false");
}

/** Draws the comparison once two tasks have been picked. */
async function draw() {
  const panel = $("compare-panel");
  panel.hidden = false;
  panel.replaceChildren(el("p", t("inspector.loading"), "meta"));
  try {
    const [first, second] = await Promise.all(chosen.map((id) => api(`runs/${id}/inspect`)));
    const a = figures(first), b = figures(second);
    const head = el("div", undefined, "compare-head");
    head.append(el("h3", t("activity.compareTitle")));
    const shut = el("button", t("activity.compareClose"), "text-button");
    shut.type = "button";
    shut.id = "compare-close";
    shut.addEventListener("click", close);
    head.append(shut);
    panel.replaceChildren(
      head,
      el("p", `${a.prompt.slice(0, 80)} · ${b.prompt.slice(0, 80)}`, "meta"),
      table(a, b),
      el("h4", "What the two answers said"),
      answerDiff(a.answer, b.answer),
    );
  } catch (error) {
    panel.replaceChildren(el("p", error.message, "inspect-bad"));
  }
}

/** The "Compare" button on one Activity row. Picking a second one draws the comparison. */
export function compareButton(runId) {
  const node = el("button", t("activity.compare"), "text-button compare-pick");
  node.type = "button";
  node.dataset.runId = runId;
  node.setAttribute("aria-pressed", String(chosen.includes(runId)));
  node.addEventListener("click", async () => {
    if (chosen.includes(runId)) {
      chosen = chosen.filter((id) => id !== runId);
      node.setAttribute("aria-pressed", "false");
      if (chosen.length < 2) { $("compare-panel").hidden = true; }
      return;
    }
    chosen = [...chosen, runId].slice(-2);
    for (const other of document.querySelectorAll(".compare-pick"))
      other.setAttribute("aria-pressed", String(chosen.includes(other.dataset.runId)));
    if (chosen.length < 2) { globalThis.toast?.(t("activity.comparePick")); return; }
    await draw();
  });
  return node;
}

globalThis.branchCompare = { button: compareButton };
