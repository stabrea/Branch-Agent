/**
 * The Usage screen: how much your assistant has done this month, what it probably cost, and the
 * limit you can put on it. A model with no price on file is always said so in words, never shown
 * as costing nothing.
 */
const $ = (id) => document.getElementById(id);
const say = (message) => (globalThis.toast ? globalThis.toast(message) : console.warn(message));
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
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
/** Money in words a person can read; null means nobody knows, and we say so. */
const money = (value) =>
  value === null || value === undefined
    ? "no price on file"
    : value > 0 && value < 0.01
      ? "less than $0.01"
      : "$" + (value < 1 ? value.toFixed(4) : value.toFixed(2));

let days = [];
let stats = null;
let budget = null;
let pricing = null;

function summaryCards(view) {
  const totals = days.reduce(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      cost: acc.cost + d.estimatedCost,
      priced: acc.priced + d.pricedRuns,
      unpriced: acc.unpriced + d.unpricedRuns,
      failures: acc.failures + d.failures,
      tokens: acc.tokens + d.tokens.input + d.tokens.output,
    }),
    { runs: 0, cost: 0, priced: 0, unpriced: 0, failures: 0, tokens: 0 },
  );
  const summary = el("div", undefined, "usage-summary");
  const cards = [
    { label: "Estimated cost", value: totals.priced ? money(totals.cost) : "no price on file" },
    { label: "Tasks", value: totals.runs },
    { label: "Tasks that did not finish", value: totals.failures },
    { label: "Words in and out (tokens)", value: totals.tokens.toLocaleString() },
  ];
  for (const card of cards) {
    const node = el("article", undefined, "summary-card");
    node.append(el("span", card.label, "label"), el("span", String(card.value), "value"));
    summary.append(node);
  }
  view.append(summary);
  if (totals.unpriced)
    view.append(el("p", `${totals.unpriced} task(s) used a model with no price on file, so their cost is not counted above.`, "subtle"));
}

/** One table: a heading, column names, and rows already turned into text. */
function table(view, heading, columns, rows) {
  if (!rows.length) return;
  const card = el("article", undefined, "table-card");
  card.append(el("h2", heading));
  const node = document.createElement("table");
  const head = node.createTHead().insertRow();
  for (const column of columns) head.append(el("th", column));
  const body = node.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (const cell of row) line.append(el("td", cell));
  }
  card.append(node);
  view.append(card);
}

/** Adds up one grouping across every day in the range. */
function rollUp(pick, key) {
  const totals = new Map();
  for (const day of days)
    for (const entry of pick(day)) {
      const existing = totals.get(entry[key]);
      if (!existing) { totals.set(entry[key], { ...entry, tokens: { ...(entry.tokens ?? { input: 0, output: 0 }) } }); continue; }
      existing.runs += entry.runs;
      if (entry.tokens) { existing.tokens.input += entry.tokens.input; existing.tokens.output += entry.tokens.output; }
      if (entry.cost !== null) existing.cost = (existing.cost ?? 0) + entry.cost;
    }
  return [...totals.values()];
}

function renderTables(view) {
  table(view, "By model", ["Model", "Tasks", "Tokens", "Estimated cost"],
    rollUp((d) => d.presets, "id").map((p) => [p.id, p.runs, (p.tokens.input + p.tokens.output).toLocaleString(), money(p.cost)]));
  table(view, "By conversation", ["Conversation", "Tasks", "Tokens", "Estimated cost"],
    rollUp((d) => d.byConversation, "sessionId").slice(0, 20)
      .map((c) => [c.sessionId.slice(0, 8), c.runs, (c.tokens.input + c.tokens.output).toLocaleString(), money(c.cost)]));
  table(view, "By where the task came from", ["From", "Tasks", "Estimated cost"],
    rollUp((d) => d.byChannel, "source").map((s) => [s.source, s.runs, money(s.cost)]));
  table(view, "Day by day", ["Day", "Tasks", "Tools used", "Tokens", "Estimated cost"],
    days.slice(0, 31).map((d) => [d.date, d.runs, d.toolCalls, (d.tokens.input + d.tokens.output).toLocaleString(),
      d.pricedRuns ? money(d.estimatedCost) : "no price on file"]));
}

function renderBudget(view) {
  const card = el("article", undefined, "budget-card");
  card.append(el("h2", "Monthly limit"));
  card.append(el("p", "Stop starting new tasks once this month reaches a number of tokens, an amount of money, or either. Leave a box empty to not use it."));
  const form = el("form", undefined, "form-grid");
  form.innerHTML = `
    <div><label for="max-monthly">Most tokens in a month</label>
      <input id="max-monthly" type="number" min="1" step="1" value="${budget?.maxMonthlyTokens ?? ""}" placeholder="No limit" /></div>
    <div><label for="max-dollars">Most money in a month (US dollars)</label>
      <input id="max-dollars" type="number" min="0.01" step="0.01" value="${budget?.maxMonthlyDollars ?? ""}" placeholder="No limit" /></div>
    <label class="check-row"><input type="checkbox" id="pause-at-budget" ${budget?.pauseAtBudget ? "checked" : ""} />
      Stop starting new tasks when the limit is reached</label>
    <button type="button" id="save-budget">Save the limit</button>`;
  card.append(form);
  if (stats)
    card.append(el("p", `So far this month: ${stats.currentMonthlyTokens.toLocaleString()} tokens` +
      (stats.estimatedCost > 0 ? `, costing about ${money(stats.estimatedCost)}.` : ". No price is on file for the models used, so the cost is unknown."), "subtle"));
  view.append(card);
  $("save-budget").addEventListener("click", () => void saveBudget());
}

async function saveBudget() {
  const tokens = parseInt($("max-monthly").value, 10);
  const dollars = parseFloat($("max-dollars").value);
  const input = { pauseAtBudget: $("pause-at-budget").checked };
  if (Number.isFinite(tokens) && tokens > 0) input.maxMonthlyTokens = tokens;
  if (Number.isFinite(dollars) && dollars > 0) input.maxMonthlyDollars = dollars;
  try {
    budget = (await api("usage/budget", input)).budget;
    say("Limit saved");
  } catch (e) { say("The limit was not saved: " + e.message); }
}

function renderPricing(view) {
  if (!pricing) return;
  const card = el("article", undefined, "table-card");
  card.append(el("h2", "Model prices"));
  card.append(el("p", `Costs are worked out from published prices last checked on ${pricing.pricedAt}. They are an estimate for your own planning, never a bill. If a price is wrong or missing, put the right one in here.`));
  const form = el("form", undefined, "form-grid");
  form.innerHTML = `
    <div><label for="price-model">Model name</label><input id="price-model" maxlength="256" placeholder="gpt-4o" /></div>
    <div><label for="price-input">Dollars per million words in</label><input id="price-input" type="number" min="0" step="0.01" /></div>
    <div><label for="price-output">Dollars per million words out</label><input id="price-output" type="number" min="0" step="0.01" /></div>
    <button type="button" id="save-price">Save this price</button>`;
  card.append(form);
  const yours = Object.entries(pricing.overrides ?? {});
  if (yours.length)
    card.append(el("p", "Your own prices: " + yours.map(([id, p]) => `${id} ($${p.input} in / $${p.output} out)`).join(", "), "subtle"));
  view.append(card);
  $("save-price").addEventListener("click", () => void savePrice());
}

async function savePrice() {
  const model = $("price-model").value.trim();
  const input = parseFloat($("price-input").value), output = parseFloat($("price-output").value);
  if (!model || !Number.isFinite(input) || !Number.isFinite(output)) { say("Fill in the model name and both prices"); return; }
  try {
    pricing = { ...pricing, ...(await api("pricing", { overrides: { ...(pricing?.overrides ?? {}), [model]: { input, output } } })) };
    say("Price saved");
    await render();
  } catch (e) { say("The price was not saved: " + e.message); }
}

function renderExport(view) {
  const card = el("article", undefined, "export-card");
  card.append(el("h2", "Save a copy"));
  card.append(el("p", "A spreadsheet file of the days above, including the estimated cost."));
  const save = el("button", "Save as a spreadsheet file");
  save.type = "button";
  save.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = "/api/usage/export.csv?range=30d";
    link.download = "usage-30d.csv";
    link.click();
  });
  card.append(save);
  view.append(card);
}

/** Loads everything the screen shows and draws it. Safe to call again at any time. */
async function render() {
  const view = $("usage");
  if (!view || !sessionStorage.getItem("branch-token")) return;
  try {
    const response = await api("usage?range=30d&by=day");
    days = response.data ?? [];
    stats = response.stats ?? null;
    pricing = response.pricing ?? null;
    budget = (await api("usage/budget")).budget;
  } catch (e) { say("The usage figures could not be loaded: " + e.message); return; }
  view.replaceChildren();
  summaryCards(view);
  renderTables(view);
  renderBudget(view);
  renderPricing(view);
  renderExport(view);
  // Batch 19 (wave 7): how this copy of Branch is doing, read from its own counters.
  await window.branchRules?.renderHealth(view);
  await window.branchEvaluation?.renderInto(view);
}

window.branchUsage = { render };
