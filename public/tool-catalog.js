/**
 * Settings → Developer → How the assistant finds its tools. A read-only look at the last request:
 * how many tools it carried in full, how many it only knew by name, how many it left out
 * altogether, and what that weighed against the ceiling. Below that, the tools it decided to load
 * before being asked and why, and everything it has been told to remember about a tool.
 *
 * The one thing this card can change is deleting all of that, which it does in one button.
 */
import { t, formatNumber } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/* The card's own words go through a key; a fixed line also carries it, so a change of language redraws it. */
const worded = (tag, key, className) => {
  const node = el(tag, t(key), className);
  node.dataset.t = key;
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
  box.append(el("p", t("tool-catalog.installed", { tools: formatNumber(report.tools) })));
  const round = report.lastRound;
  box.append(round
    ? el("p", t("tool-catalog.last-round", {
      loaded: formatNumber(round.loaded), indexed: formatNumber(round.indexed), deferred: formatNumber(round.deferred),
      estimated: formatNumber(round.estimatedTokens), budget: formatNumber(round.budgetTokens),
    }))
    : worded("p", "tool-catalog.no-round"));
  const health = healthWords(report.health);
  if (health) box.append(el("p", health, "subtle"));
}

/** The nightly look at the catalog, said from its numbers in the chosen language; an older saved one keeps its words. */
function healthWords(health) {
  if (!health) return "";
  if (typeof health.runs !== "number" || !Array.isArray(health.tools)) return health.summary ?? "";
  if (!health.runs) return t("tool-catalog.health.none");
  const weighed = health.averageRoundTokens ? "weighed" : "unweighed";
  const found = health.searches ? "found" : "none";
  return t("tool-catalog.health.used", { runs: formatNumber(health.runs), tools: formatNumber(health.tools.length) }) + " "
    + t(`tool-catalog.health.${weighed}-${found}`, {
      tokens: formatNumber(health.averageRoundTokens), rate: formatNumber(Math.round(health.searchHitRate * 100)),
    });
}

/** Who would receive the request, in the chosen language; the sentence says the same as the server's. */
function explanationOf(state) {
  const kind = state.receiver?.kind;
  if (!["unknown", "local", "provider"].includes(kind)) return state.explanation;
  const receiver = t(`tool-catalog.meaning.receiver.${kind}`, { provider: state.receiver.provider ?? "" });
  return t("tool-catalog.meaning.explanation", { receiver });
}

/** Why a tool was ready before it was asked for, and what it has been told to remember. */
function listsOf(report) {
  const box = $("tool-catalog-lists");
  box.replaceChildren();
  if (report.preloaded.length) {
    box.append(worded("h3", "tool-catalog.preloaded"));
    const list = el("ul");
    for (const entry of report.preloaded) list.append(el("li", `${entry.name} — ${entry.reason}`));
    box.append(list);
  }
  box.append(worded("h3", "tool-catalog.notes"));
  if (!report.notes.length) { box.append(worded("p", "tool-catalog.no-notes", "subtle")); return; }
  const notes = el("ul");
  for (const note of report.notes) {
    const row = el("li", `${note.tool}: ${note.note} `);
    const remove = worded("button", "tool-catalog.delete-note");
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
 * stays off until you say otherwise, because it sends your request somewhere: the sentence says
 * the same as the engine's, word for word in English, and names who would receive the request.
 */
async function meaningSearch() {
  const box = $("tool-catalog-meaning");
  if (!box) return;
  const state = await api("tools/meaning-search");
  box.replaceChildren(worded("h3", "tool-catalog.meaning.title"));
  box.append(el("p", explanationOf(state), "subtle"));
  if (!state.available) {
    box.append(worded("p", "tool-catalog.meaning.unavailable", "subtle"));
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
  const words = worded("span", "tool-catalog.meaning.switch");
  label.append(tick, " ", words);
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
    status.textContent = t("tool-catalog.forgotten", { history: formatNumber(result.history), notes: formatNumber(result.notes) });
    await renderToolCatalog();
  } catch (error) {
    status.textContent = String(error.message || error);
  }
});
/* Lines with numbers in them are drawn afresh in the new language while the card is open. */
document.addEventListener("branch-language", () => { if ($("tool-catalog")?.open) void renderToolCatalog(); });
