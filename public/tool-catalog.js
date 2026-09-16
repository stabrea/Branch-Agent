/**
 * Settings → Developer → How the assistant finds its tools. A read-only look at the last request:
 * how many tools it carried in full, how many it only knew by name, how many it left out
 * altogether, and what that weighed against the ceiling. Below that, the tools it decided to load
 * before being asked and why, and everything it has been told to remember about a tool.
 *
 * The one thing this card can change is deleting all of that, which it does in one button.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path, method = "GET", body) {
  const response = await fetch("/api/" + path, {
    method,
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** The one line about the last request, in ordinary words. */
function summaryOf(report) {
  const box = $("tool-catalog-summary");
  box.replaceChildren();
  box.append(el("p", `${report.tools} tools are installed on this computer.`));
  const round = report.lastRound;
  box.append(el("p", round
    ? `Last time it worked it carried ${round.loaded} of them in full, knew ${round.indexed} more by name, and left ${round.deferred} to look up if needed — about ${round.estimatedTokens} of its ${round.budgetTokens} token allowance for tools.`
    : "It has not worked on anything yet, so there is nothing to show."));
  if (report.health?.summary) box.append(el("p", report.health.summary, "subtle"));
}

/** Why a tool was ready before it was asked for, and what it has been told to remember. */
function listsOf(report) {
  const box = $("tool-catalog-lists");
  box.replaceChildren();
  if (report.preloaded.length) {
    box.append(el("h3", "Ready before you asked"));
    const list = el("ul");
    for (const entry of report.preloaded) list.append(el("li", `${entry.name} — ${entry.reason}`));
    box.append(list);
  }
  box.append(el("h3", "Things it remembers about a tool"));
  if (!report.notes.length) { box.append(el("p", "Nothing yet.", "subtle")); return; }
  const notes = el("ul");
  for (const note of report.notes) {
    const row = el("li", `${note.tool}: ${note.note} `);
    const remove = el("button", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      await api("tools/notes/" + note.id, "DELETE");
      await renderToolCatalog();
    });
    row.append(remove);
    notes.append(row);
  }
  box.append(notes);
}

/**
 * Finding a tool by what it does rather than by the words you happened to use. It is off, and
 * stays off until you say otherwise, because it sends your request somewhere: the sentence the
 * engine gives is shown exactly as it is written there, so this screen cannot soften it.
 */
async function meaningSearch() {
  const box = $("tool-catalog-meaning");
  if (!box) return;
  const state = await api("tools/meaning-search");
  box.replaceChildren(el("h3", "Finding tools by meaning"));
  box.append(el("p", state.explanation, "subtle"));
  if (!state.available) {
    box.append(el("p", "None of your connected models can compare writing yet, so this cannot be turned on.", "subtle"));
    return;
  }
  const label = el("label");
  const tick = document.createElement("input");
  tick.type = "checkbox";
  tick.checked = state.enabled === true;
  tick.addEventListener("change", async () => {
    await api("tools/meaning-search", "POST", { enabled: tick.checked });
    await meaningSearch();
  });
  label.append(tick, document.createTextNode(" Also find tools by meaning"));
  box.append(label);
}

export async function renderToolCatalog() {
  const status = $("tool-catalog-status");
  if (!status) return;
  try {
    const report = await api("tools/catalog");
    summaryOf(report);
    listsOf(report);
    await meaningSearch();
    status.textContent = "";
  } catch (error) {
    status.textContent = String(error.message || error);
  }
}

$("tool-catalog-forget")?.addEventListener("click", async () => {
  const status = $("tool-catalog-status");
  try {
    const result = await api("tools/forget", "POST", { what: "all" });
    status.textContent = `Forgotten: ${result.history} tasks and ${result.notes} notes. Your tools are untouched.`;
    await renderToolCatalog();
  } catch (error) {
    status.textContent = String(error.message || error);
  }
});
