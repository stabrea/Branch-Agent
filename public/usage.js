/**
 * The Usage screen: how much your assistant has done this month, what it probably cost, and the
 * limit you can put on it. A model with no price on file is always said so in words, never shown
 * as costing nothing.
 */
import { t } from "/i18n.js";

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
let statistics = null;
let metering = null;
let limits = null; // mac7/usage-bar
let glanceSettings = null; // redesign phase 1: the ring and the question at 95%

/* ---------- Wave 7: this month, and what it is heading for ---------- */

/** The days of the calendar month that `when` falls in. */
function monthDays(when = new Date()) {
  const prefix = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-`;
  return days.filter((day) => day.date.startsWith(prefix));
}
/**
 * What this month has cost so far and, at the same daily pace, what the whole month would come to.
 * A month with no priced task returns null rather than a made-up number.
 */
export function forecastMonth(month, today = new Date()) {
  const cost = month.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const priced = month.reduce((total, day) => total + day.pricedRuns, 0);
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  if (!priced || dayOfMonth < 1) return { cost, priced, projected: null, daysInMonth };
  return { cost, priced, projected: (cost / dayOfMonth) * daysInMonth, daysInMonth };
}

/** The month card: what it has cost, what it is heading for, and the same money broken three ways. */
function renderMonth(view) {
  const month = monthDays();
  const card = el("article", undefined, "table-card month-card");
  card.id = "usage-month";
  card.append(el("h2", "This month"));
  const { cost, priced, projected } = forecastMonth(month);
  card.append(el("p", priced
    ? `So far this month: ${money(cost)} across ${priced} task(s) with a price on file.`
    : "No task this month used a model with a price on file, so there is nothing to add up.", "month-so-far"));
  /* The plain sentence a person can act on. It says "about", because it is a guess from the pace. */
  card.append(el("p", projected === null
    ? "There is no price on file for the models used, so this month cannot be guessed at."
    : `At this pace, about ${money(projected)} this month.`, "month-forecast"));
  view.append(card);
  const only = (pick, key) => rollUpOver(month, pick, key);
  table(view, "This month by model", ["Model", "Tasks", "Tokens", "Estimated cost"],
    only((d) => d.presets, "id").map((p) => [p.id, p.runs, (p.tokens.input + p.tokens.output).toLocaleString(), money(p.cost)]));
  table(view, "This month by conversation", ["Conversation", "Tasks", "Tokens", "Estimated cost"],
    only((d) => d.byConversation, "sessionId").slice(0, 20)
      .map((c) => [c.sessionId.slice(0, 8), c.runs, (c.tokens.input + c.tokens.output).toLocaleString(), money(c.cost)]));
  table(view, "This month by where the task came from", ["From", "Tasks", "Estimated cost"],
    only((d) => d.byChannel, "source").map((s) => [s.source, s.runs, money(s.cost)]));
}

/** How this copy of Branch is behaving, rather than what it cost. */
function renderStatistics(view) {
  if (!statistics) return;
  const card = el("article", undefined, "table-card");
  card.id = "usage-statistics";
  card.append(el("h2", "How it has been going"));
  const rate = statistics.toolSuccessRate;
  const rows = [
    ["Middle round size", statistics.medianTokensPerRound === null
      ? "no rounds yet" : `${statistics.medianTokensPerRound.toLocaleString()} tokens`],
    ["Rounds counted", statistics.rounds.toLocaleString()],
    ["Tools that worked", rate === null ? "no tools used yet" : `${Math.round(rate * 100)}% of ${statistics.toolCalls.toLocaleString()}`],
    ["Conversations shortened to make room", statistics.compactions.toLocaleString()],
  ];
  const node = document.createElement("table");
  const body = node.createTBody();
  for (const [label, value] of rows) {
    const line = body.insertRow();
    line.append(el("th", label), el("td", value));
  }
  card.append(node);
  view.append(card);
}

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
const rollUp = (pick, key) => rollUpOver(days, pick, key);
/** The same, over whichever days you hand it, so the month card can use it too. */
function rollUpOver(list, pick, key) {
  const totals = new Map();
  for (const day of list)
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
  card.append(el("h2", t("usage.card.limit")));
  card.append(el("p", t("usage.card.limitPurpose")));
  const form = el("form", undefined, "form-grid");
  form.innerHTML = `
    <div><label for="max-monthly">Most tokens in a month</label>
      <input id="max-monthly" type="number" min="1" step="1" value="${budget?.maxMonthlyTokens ?? ""}" placeholder="No limit" /></div>
    <div><label for="max-dollars">Most money in a month, in US dollars</label>
      <input id="max-dollars" type="number" min="0.01" step="0.01" value="${budget?.maxMonthlyDollars ?? ""}" placeholder="No limit" /></div>
    <label class="check-row"><input type="checkbox" id="pause-at-budget" ${budget?.pauseAtBudget ? "checked" : ""} />
      Stop starting new tasks when the limit is reached</label>
    <button type="button" id="save-budget">Save the limit</button>`;
  card.append(form);
  if (stats)
    card.append(el("p", `So far this month: ${stats.currentMonthlyTokens.toLocaleString()} tokens` +
      (stats.estimatedCost > 0 ? `, costing about ${money(stats.estimatedCost)}.` : ". No price is on file for the models used, so the cost is unknown."), "subtle"));
  // hardening-3: money a running task has already spent (a video it asked for) is in that figure; say so.
  if (stats?.stillBeingMade > 0) card.append(el("p", t("usage.stillBeingMade", { money: money(stats.stillBeingMade) }), "subtle"));
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
  /* Wave 7: the same tasks as trajectories, one a line, for an evaluation tool to read. */
  card.append(el("p", "Every task's full record, one per line, for feeding an evaluation run."));
  const lines = el("button", "Save the tasks as one file per line");
  lines.type = "button";
  lines.id = "save-trajectories";
  lines.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = "/api/runs/trajectories.jsonl?limit=100";
    link.download = "branch-trajectories.jsonl";
    link.click();
  });
  card.append(lines);
  view.append(card);
}

/**
 * Wave 7: writing the month's figures out as a spreadsheet, on a schedule, into a folder of your
 * own workspace. It is off until you ask for it, and nothing is ever sent anywhere.
 */
function renderMetering(view) {
  const card = el("article", undefined, "table-card");
  card.id = "usage-metering";
  card.append(el("h2", "Write the figures out on a schedule"));
  card.append(el("p", "Keeps a spreadsheet of this month's usage in a folder of your workspace, written again at the interval you choose. It is only ever written on this computer; nothing is sent anywhere."));
  const form = el("form", undefined, "form-grid");
  form.innerHTML = `
    <label class="check-row"><input type="checkbox" id="metering-enabled" ${metering?.enabled ? "checked" : ""} />
      Keep a spreadsheet of this month's usage</label>
    <div><label for="metering-folder">Folder in your workspace</label>
      <input id="metering-folder" maxlength="200" value="${(metering?.folder ?? "usage").replace(/"/g, "&quot;")}" placeholder="usage" /></div>
    <div><label for="metering-every">How often</label>
      <select id="metering-every">
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
      </select></div>
    <button type="button" id="metering-save">Save this</button>
    <button type="button" id="metering-now">Write it now</button>`;
  card.append(form);
  card.append(el("p", metering?.lastWrittenAt
    ? `Last written ${new Date(metering.lastWrittenAt).toLocaleString()} to ${metering.lastFile}.`
    : "Nothing has been written yet.", "subtle"));
  const status = el("p", "", "subtle");
  status.id = "metering-status";
  status.setAttribute("role", "status");
  card.append(status);
  view.append(card);
  $("metering-every").value = metering?.every ?? "daily";
  $("metering-save").addEventListener("click", () => void saveMetering());
  $("metering-now").addEventListener("click", () => void writeMeteringNow());
}
async function saveMetering() {
  try {
    metering = (await api("usage/metering", {
      enabled: $("metering-enabled").checked,
      folder: $("metering-folder").value.trim() || "usage",
      every: $("metering-every").value,
    })).metering;
    $("metering-status").textContent = "Saved.";
  } catch (e) { $("metering-status").textContent = e.message; }
}
async function writeMeteringNow() {
  try {
    const written = await api("usage/metering/now", {});
    metering = written.metering;
    $("metering-status").textContent = `Written to ${written.path} (${written.days} day(s)).`;
  } catch (e) { $("metering-status").textContent = e.message; }
}


/* ---------- mac7/usage-bar: what each connection has left ---------- */

/** "4 min ago", or nothing at all when nobody said when. A number with no age is not shown. */
function ageOf(measuredAt) {
  if (!measuredAt) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(measuredAt).getTime()) / 1000));
  if (seconds < 90) return "as of just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `as of ${minutes} min ago` : `as of ${Math.round(minutes / 60)} h ago`;
}

/**
 * One window. A measured share draws a bar; an estimate draws a lighter one and always says the
 * word "estimate" and what it was worked out from. A remainder nobody gave us draws no bar at all,
 * because a bar with no number behind it is exactly the invention this screen exists to avoid.
 */
function limitWindow(window) {
  const row = el("div", undefined, `limit-window limit-${window.state}`);
  row.append(el("span", window.title, "limit-window-title"));
  const share = window.kind !== "money" && window.limit > 0 && window.remaining !== null
    ? Math.max(0, Math.min(100, (window.remaining / window.limit) * 100)) : null;
  if (share === null) {
    row.append(el("span", window.remaining === null
      ? "left: not said" : `${window.remaining} left of ${window.limit ?? "an unstated allowance"}`, "limit-figure"));
  } else {
    const bar = el("div", undefined, "limit-bar");
    const fill = el("div", undefined, "limit-bar-fill");
    fill.style.width = `${share.toFixed(1)}%`;
    bar.append(fill);
    row.append(bar, el("span", `${Math.round(share)}% left`, "limit-figure"));
  }
  const age = ageOf(window.measuredAt);
  const said = window.state === "estimated" ? `estimate — ${window.from}` : window.from;
  row.append(el("span", [said, age, window.resetAt ? `refills ${new Date(window.resetAt).toLocaleTimeString()}` : null]
    .filter(Boolean).join(" · "), "limit-source subtle"));
  return row;
}

/** One connection, or one account inside a connection. Never two accounts added together. */
function limitRow(row) {
  const card = el("article", undefined, `limit-row limit-${row.state}`);
  const heading = row.accountLabel ? `${row.connectionName} — ${row.accountLabel}` : row.connectionName;
  card.append(el("h3", row.inUse && row.accountLabel ? `${heading} (in use)` : heading));
  if (row.state === "not_published") card.append(el("p", row.note, "limit-note"));
  else {
    for (const window of row.windows) card.append(limitWindow(window));
    if (row.note) card.append(el("p", row.note, "limit-note subtle"));
  }
  return card;
}

/**
 * The panel. It ships looking sparse, and the sparseness is the point: most services publish
 * nothing a program may lawfully read, and saying so is a better answer than filling the gap.
 */
function renderLimits(view) {
  const card = el("article", undefined, "table-card");
  card.id = "usage-limits";
  /* Its section's heading already says this (DG-081); the title stays for a screen reader. */
  card.append(el("h2", "What each connection has left", "sr-only"));
  card.append(el("p", "Only what a service actually told Branch, with the time it said it. Where a service publishes nothing, this says so rather than guessing. Accounts are listed one by one and never added together: subscriptions are not interchangeable, and keys in one organisation share a single limit."));
  if (limits === null) return; // Refused, not empty: somebody other than the owner is looking.
  if (limits.empty) {
    card.append(el("p", limits.summary, "limit-note"));
    view.append(card);
    return;
  }
  for (const row of limits.rows) card.append(limitRow(row));
  card.append(el("p", limits.summary, "subtle"));
  const ask = el("label", undefined, "check-row");
  const box = el("input");
  box.type = "checkbox";
  box.id = "limits-ask";
  box.checked = limits.settings?.enabled ?? false;
  ask.append(box, document.createTextNode(" Ask OpenRouter what is left on its key, on a timer"));
  card.append(ask);
  card.append(el("p", "OpenRouter publishes a web address for this, so asking is fair. No subscription account is ever asked: the question itself would spend the allowance it is measuring.", "subtle"));
  box.addEventListener("change", () => void saveLimitsSwitch(box.checked));
  renderGlanceSettings(card);
  view.append(card);
}
/* Redesign phase 1: the ring under the message box can be hidden, and the question at 95% switched
   off. Both are the owner's, and both are saved with the workspace (public/usage-glance.js reads them). */
function glanceSwitch(id, key, checked, onChange) {
  const row = el("label", undefined, "check-row");
  const box = el("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = checked;
  box.addEventListener("change", () => void onChange(box.checked));
  row.append(box, document.createTextNode(" " + t(key)));
  return row;
}
function renderGlanceSettings(card) {
  if (!glanceSettings) return;
  card.append(glanceSwitch("glance-ring", "glance.setting.ring", glanceSettings.ring !== "hidden",
    (on) => saveGlance({ ring: on ? "shown" : "hidden" })));
  card.append(glanceSwitch("glance-save-progress", "glance.setting.save", glanceSettings.saveProgress === "ask",
    (on) => saveGlance({ saveProgress: on ? "ask" : "off" })));
  card.append(el("p", t("glance.setting.saveNote"), "subtle"));
}
async function saveGlance(change) {
  try {
    glanceSettings = (await api("usage/glance/settings", change)).settings;
    document.dispatchEvent(new CustomEvent("branch-usage-glance"));
  } catch (e) { say(e.message); }
}
async function saveLimitsSwitch(on) {
  try {
    await api("usage/limits/settings", { mode: on ? "on" : "off", enabled: on });
    limits = await api("usage/limits");
  } catch (e) { say(e.message); }
}

/*
 * DG-081: Data & usage reads as the approved sample does, usage first: the usage itself, then what each connection
 * has left, then (after what is kept) what it costs, and the spreadsheet under the hood. The parts that live under
 * another heading are drawn into cards of their own, which say where they belong (data-home) and are placed by
 * public/settings-buckets.js. The figures are the same figures.
 */
function host(id) {
  let card = $(id);
  if (!card) {
    card = el("section", undefined, "usage-part");
    card.id = id;
    card.dataset.home = "settings:data";
    document.body.append(card);
  }
  return card;
}

/** Loads everything the screen shows and draws it. Safe to call again at any time. */
async function render() {
  const view = $("usage");
  if (!view || !sessionStorage.getItem("branch-token")) return;
  try {
    const response = await api("usage?range=30d&by=day");
    days = response.data ?? [];
    stats = response.stats ?? null;
    statistics = response.statistics ?? null;
    pricing = response.pricing ?? null;
    budget = (await api("usage/budget")).budget;
    metering = (await api("usage/metering")).metering;
    // mac7/usage-bar: allowed to be missing — a household profile is refused these outright.
    limits = await api("usage/limits").catch(() => null);
    glanceSettings = limits ? (await api("usage/glance/settings").catch(() => null))?.settings ?? null : null;
  } catch (e) { say("The usage figures could not be loaded: " + e.message); return; }
  const left = host("usage-left-card"), costs = host("usage-costs-card"), sheet = host("usage-sheet-card");
  for (const part of [view, left, costs, sheet]) part.replaceChildren();
  // Wave 8: every section opens by saying what it is for, in one line.
  view.append(el("p", t("usage.intro"), "section-intro"));
  summaryCards(view);
  // mac7/usage-bar: what each connection has left, in a card of its own after the usage, and never in the meter
  // under the message box — that bar is this conversation's room against the model's context window, which is
  // a different thing entirely and must not be conflated with a provider's allowance.
  renderLimits(left);
  // Batch 19 (wave 7): this month first, because that is the question people actually ask.
  renderMonth(view);
  renderStatistics(view);
  renderTables(view);
  renderBudget(costs);
  renderPricing(costs);
  renderExport(view);
  renderMetering(sheet);
  // Batch 19 (wave 7): how this copy of Branch is doing, read from its own counters.
  await window.branchRules?.renderHealth(view);
  await window.branchEvaluation?.renderInto(view);
  // Batch 19 (wave 7): written-down experiments over suites and benchmarks.
  await window.branchStudies?.renderInto(view);
  // Wave 8: how busy each connection is against the allowance it reports, and what asking the same
  // thing twice saved (public/logs.js).
  await window.branchDashboards?.renderInto(view);
}

window.branchUsage = { render };
