/**
 * The Knowledge card inside Documents: whole folders of the person's own work, read into passages
 * so the assistant can find the right page and say where it came from. Its own file; the page only
 * provides the empty card.
 */
const $ = (id) => document.getElementById(id);
let view = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const say = (message) => { $("knowledge-status").textContent = message; };
async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
const when = (value) => (value ? new Date(value).toLocaleString() : "not read yet");

export async function loadKnowledge() {
  view = await request("/api/knowledge");
  render();
}
function render() {
  if (!view) return;
  $("knowledge-meaning").textContent = view.meaningSearch
    ? `Your knowledge bases are matched by wording and by meaning${view.onThisComputer ? ", read by a model on this computer so nothing leaves it" : ` (read by ${view.model})`}.`
    : "Your knowledge bases are matched by the words in them. Connect a model that can compare writing by meaning to also match by meaning.";
  const list = $("knowledge-list");
  list.replaceChildren();
  if (!view.collections.length) {
    list.append(el("p", "No knowledge bases yet. Name one above and point it at a folder.", "empty"));
    return;
  }
  for (const entry of view.collections) list.append(card(entry));
}
function card(entry) {
  const node = el("div", undefined, "item");
  node.append(el("h3", entry.name));
  node.append(el("p", `${entry.documents} file${entry.documents === 1 ? "" : "s"} · ${entry.chunks} passage${entry.chunks === 1 ? "" : "s"}` +
    (entry.embedded ? ` · ${entry.embedded} matched by meaning` : "") + ` · last read ${when(entry.lastIndexedAt)}`));
  if (entry.indexTokens)
    node.append(el("p", `Reading it has sent about ${entry.indexTokens.toLocaleString()} units of text to the model so far.`, "meta"));
  if (entry.model) node.append(el("p", `Read by ${entry.model}`, "meta"));
  if (entry.note) node.append(el("p", entry.note));
  node.append(el("p", entry.sources.map((source) => source.path).join(", ") || "No folders yet", "meta"));
  const use = el("label", undefined, "check-row");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = entry.attached;
  box.addEventListener("change", () => act(box, () =>
    request("/api/knowledge/attach", { body: { collection: entry.id, attached: box.checked } })));
  use.append(box, document.createTextNode(" Use this when answering"));
  node.append(use);
  node.append(button("Read it again", () => request("/api/knowledge/reindex", { body: { collection: entry.id } })));
  node.append(button("Remove", () => request(`/api/knowledge/${entry.id}`, { method: "DELETE" })));
  return node;
}
function button(label, run) {
  const node = el("button", label);
  node.type = "button";
  node.addEventListener("click", () => act(node, run));
  return node;
}
async function act(node, run) {
  node.disabled = true;
  say(node.textContent === "Read it again" ? "Reading your files…" : "");
  try { await run(); say(""); await loadKnowledge(); } catch (error) { say(error.message); }
  finally { node.disabled = false; }
}

function passage(hit) {
  const node = el("div", undefined, "item");
  node.append(el("h3", hit.documentName));
  const where = [hit.collectionName, hit.heading, hit.page === null ? "" : `page ${hit.page}`].filter(Boolean).join(" › ");
  node.append(el("p", where, "meta"));
  node.append(el("p", hit.text));
  return node;
}
async function search(query) {
  const results = $("knowledge-results");
  results.replaceChildren();
  const { results: found } = await request("/api/knowledge/search", { body: { query, limit: 5 } });
  if (!found.length) { results.append(el("p", "Nothing in your knowledge bases matches that.", "empty")); return; }
  for (const hit of found) results.append(passage(hit));
}

function wire() {
  $("knowledge-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("knowledge-name").value.trim(), folder = $("knowledge-folder").value.trim();
    if (!name) return;
    say(`Creating ${name}…`);
    try {
      const made = await request("/api/knowledge", { body: { name, sources: folder ? [{ kind: "folder", path: folder }] : [] } });
      $("knowledge-name").value = ""; $("knowledge-folder").value = "";
      if (folder) { say("Reading your files…"); await request("/api/knowledge/reindex", { body: { collection: made.id } }); }
      say(""); await loadKnowledge();
    } catch (error) { say(error.message); }
  });
  $("knowledge-search-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("knowledge-query").value.trim();
    if (!query) return;
    try { await search(query); say(""); } catch (error) { say(error.message); }
  });
  document.querySelector('.nav[data-view="documents"]')
    ?.addEventListener("click", () => { loadKnowledge().catch((error) => say(error.message)); });
}
wire();
