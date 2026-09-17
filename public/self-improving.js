/**
 * The two Memory cards that let the assistant get better the more it is used, and let the owner
 * stay in charge of it. Everything here either looks without changing anything, or adds to the
 * queue of suggestions the owner decides on. Nothing on this page writes a remembered fact.
 */
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const signals = {
  "file-revisited": "A file you keep coming back to",
  "name-recurs": "A name that keeps turning up",
  correction: "Something you put me right about",
};

/** What the assistant noticed, each with the thing it was learned from underneath it. */
function drawNoticed(noticed) {
  const list = $("memory-learned-list");
  list.replaceChildren();
  if (!noticed.length) {
    list.append(el("p", "Nothing new has been noticed. Keep working and look again later.", "meta"));
    return;
  }
  for (const entry of noticed) {
    const card = el("div", undefined, "card");
    card.append(el("strong", entry.text), el("p", signals[entry.signal] ?? entry.signal, "meta"));
    for (const line of entry.evidence) card.append(el("p", `Learned from: ${line}`, "subtle"));
    list.append(card);
  }
}
async function lookAtNoticed() {
  try { drawNoticed((await api("memory/learned")).noticed); }
  catch (error) { toast(error.message); }
}
async function offerNoticed() {
  try {
    const done = await api("memory/learned", {});
    toast(done.noticed
      ? `${done.noticed} suggestion${done.noticed === 1 ? "" : "s"} added under "What it learns". Nothing is remembered until you accept it.`
      : "There was nothing to offer.");
    await lookAtNoticed();
  } catch (error) { toast(error.message); }
}

/** The cost first, always. The button that actually reads anything stays off until it is shown. */
async function showRefreshCost() {
  try {
    const cost = await api("memory/refresh");
    $("memory-refresh-status").textContent = cost.summary;
    $("memory-refresh-run").disabled = cost.conversations === 0;
  } catch (error) { toast(error.message); }
}
async function runRefresh() {
  const collection = $("memory-refresh-collection").value.trim();
  if (!collection) { toast("Name the knowledge base the cards would go in."); return; }
  $("memory-refresh-run").disabled = true;
  try {
    const done = await api("knowledge/refresh", { collection });
    $("memory-refresh-status").textContent = done.staged.length
      ? `${done.staged.length} card${done.staged.length === 1 ? "" : "s"} suggested. Accept them under "What it learns". ${done.reason}`.trim()
      : `Nothing was suggested. ${done.reason}`.trim();
  } catch (error) { toast(error.message); $("memory-refresh-run").disabled = false; }
}

export function setUpSelfImproving() {
  if ($("memory-learned-card")) {
    $("memory-learned-look").addEventListener("click", lookAtNoticed);
    $("memory-learned-suggest").addEventListener("click", offerNoticed);
  }
  if ($("memory-refresh-card")) {
    $("memory-refresh-cost").addEventListener("click", showRefreshCost);
    $("memory-refresh-run").addEventListener("click", runRefresh);
  }
}
setUpSelfImproving();
