/**
 * Batch 19 (wave 7): a small card under "Check how well it is doing". It lists the experiments you
 * have written down, runs one, and shows the table that comes back. Nothing is downloaded and
 * nothing is sent anywhere; a benchmark reads files you already put on this computer.
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

/** One table of results: a line per model choice. */
function rowsTable(rows) {
  const table = el("table");
  const head = el("tr");
  for (const label of ["Model choice", "Tasks", "Right", "Time each", "Cost"]) head.append(el("th", label));
  table.append(head);
  for (const row of rows) {
    const line = el("tr");
    line.append(el("td", row.preset));
    line.append(el("td", row.tasks));
    line.append(el("td", `${row.passed} (${Math.round(row.accuracy * 100)}%)`));
    line.append(el("td", `${row.meanMs} ms`));
    line.append(el("td", row.dollars === null ? "no price on file" : "$" + row.dollars.toFixed(4)));
    table.append(line);
  }
  return table;
}

async function runStudy(id, area, button) {
  area.replaceChildren(el("p", "Working through the experiment. It picks up where it left off if it was stopped before."));
  button.disabled = true;
  try {
    const { result } = await api("studies/run", { id });
    area.replaceChildren();
    if (result.resumed) area.append(el("p", `${result.resumed} of the ${result.cells.length} runs were already done and were not repeated.`));
    if (result.stoppedEarly) area.append(el("p", result.stoppedEarly, "warning"));
    area.append(rowsTable(result.rows));
  } catch (error) {
    area.replaceChildren(el("p", "The experiment could not be run: " + error.message));
  } finally {
    button.disabled = false;
  }
}

/** Draws the card. Nothing runs until the person asks for it. */
export async function renderInto(view) {
  let studies = [], benchmarks = { adapters: [], notIntegrated: [] };
  try {
    studies = (await api("studies")).studies ?? [];
    benchmarks = await api("evaluation/benchmarks");
  } catch { return; }
  const card = el("article", undefined, "evaluation-card");
  card.append(el("h2", "Experiments"));
  card.append(el("p", "An experiment runs the same set of tasks against one or more model choices, several at a time, and keeps every result. Stop it and start it again and it carries on where it left off."));
  if (!studies.length) {
    card.append(el("p", "You have not written one down yet. There is a short guide under \"Measuring the assistant\" in the settings notes."));
  } else {
    const picker = el("select");
    picker.id = "study-choice";
    for (const study of studies) {
      const option = el("option", study.name);
      option.value = study.id;
      picker.append(option);
    }
    const label = el("label", "Which experiment");
    label.htmlFor = "study-choice";
    const area = el("div", undefined, "evaluation-result");
    const button = el("button", "Run this experiment");
    button.type = "button";
    button.addEventListener("click", () => void runStudy(picker.value, area, button));
    card.append(label, picker, button, area);
  }
  const names = benchmarks.adapters.map((adapter) => adapter.name).join(", ");
  card.append(el("p", `Test sets it can read from files on this computer: ${names}.`));
  card.append(el("p", `Not supported, because they each need a separate virtual computer or a live website: ${benchmarks.notIntegrated.map((entry) => entry.name).join(", ")}.`));
  view.append(card);
}

window.branchStudies = { renderInto };
