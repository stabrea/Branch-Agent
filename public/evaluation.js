/**
 * A small card on the Usage screen: run one of the ready-made test suites against the model you
 * are using, see which tasks it got right, what it cost, and whether anything that used to work
 * has stopped working.
 */
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
const money = (value) =>
  value === null || value === undefined ? "no price on file"
    : value > 0 && value < 0.01 ? "less than $0.01"
      : "$" + (value < 1 ? value.toFixed(4) : value.toFixed(2));

function resultTable(result) {
  const table = el("table");
  const head = el("tr");
  for (const label of ["Task", "Result", "Time", "Why"]) head.append(el("th", label));
  table.append(head);
  for (const task of result.tasks) {
    const row = el("tr");
    row.append(el("td", task.id));
    row.append(el("td", task.skipped ? "skipped" : task.passed ? "right" : "wrong"));
    row.append(el("td", `${task.ms} ms`));
    row.append(el("td", task.problem ?? ""));
    table.append(row);
  }
  return table;
}

/** Runs the chosen suite and replaces the card's result area with what came back. */
async function runSuite(id, area, button) {
  area.replaceChildren(el("p", "Working through the tasks. This asks the model a question for each one."));
  button.disabled = true;
  try {
    const result = await api("evaluation/run", { suite: id });
    area.replaceChildren();
    area.append(el("p", `${result.summary.passed} of ${result.summary.total} right, ${result.summary.latencyMs.mean} ms each on average, ${money(result.summary.dollars)}.`));
    if (result.summary.skipped) area.append(el("p", `${result.summary.skipped} task(s) skipped: something they need is not installed.`));
    if (result.regressions.length)
      area.append(el("p", `Something that used to work has stopped: ${result.regressions.map((entry) => entry.taskId).join(", ")}.`, "warning"));
    area.append(resultTable(result));
  } catch (e) {
    area.replaceChildren(el("p", "The tests could not be run: " + e.message));
  } finally {
    button.disabled = false;
  }
}

/** Draws the card. Nothing is run until the person asks for it. */
export async function renderInto(view) {
  let suites = [];
  try { suites = (await api("evaluation/suites")).suites ?? []; } catch { return; }
  if (!suites.length) return;
  const card = el("article", undefined, "evaluation-card");
  card.append(el("h2", "Check how well it is doing"));
  card.append(el("p", "Run a set of ready-made tasks and see how many the model gets right, how long it takes and what it costs. Nothing here is sent anywhere."));
  const picker = el("select");
  picker.id = "evaluation-suite";
  for (const suite of suites) {
    const option = el("option", `${suite.name}${suite.source === "yours" ? " (yours)" : ""}`);
    option.value = suite.id;
    picker.append(option);
  }
  const chosen = el("label", "Which set of tasks");
  chosen.htmlFor = "evaluation-suite";
  card.append(chosen, picker);
  const description = el("p", suites[0].description);
  picker.addEventListener("change", () => {
    description.textContent = suites.find((suite) => suite.id === picker.value)?.description ?? "";
  });
  card.append(description);
  const area = el("div", undefined, "evaluation-result");
  const button = el("button", "Run these tasks");
  button.type = "button";
  button.addEventListener("click", () => void runSuite(picker.value, area, button));
  card.append(button, area);
  view.append(card);
}

window.branchEvaluation = { renderInto };
