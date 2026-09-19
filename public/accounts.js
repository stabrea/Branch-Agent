// Several accounts per connection (mac6/accounts), on their own Settings page since redesign phase 2
// (critique #61): every sign-in and key in one place, per provider with its mark, which one answers,
// which key each Trunk uses, and what happens when one runs low. The sharing rule is the server's
// (src/accounts/, mac7/account-pooling): the page only shows it, in the same words. A chip in the
// title bar names the account the conversation's model answers through. Keys and sign-ins never
// reach this page.
import { t, formatNumber, formatDate } from "/i18n.js";
import { markTile } from "/brand-marks.js"; // phase2/accounts

const $ = (id) => document.getElementById(id);
const token = () => { try { return sessionStorage.getItem("branch-token") || ""; } catch { return ""; } };
let said = "";
let last = null;
let query = "";
/** Which accounts have "More" unfolded, so a redraw after a change keeps them open. */
const unfolded = new Set();

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const api = (path = "", body) => request("/api/accounts" + path, body);

function node(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}
/** A node whose words come from a key; with values it is redrawn rather than retranslated in place. */
function worded(tag, key, className, values) {
  const made = node(tag, className, t(key, values));
  if (values) made.dataset.tKey = key; else made.dataset.t = key;
  return made;
}
/** The owner's own words (an account's name): data, shown as typed. */
const data = (tag, text, className = "") => {
  const made = node(tag, `accounts-data ${className}`.trim(), text);
  made.style.overflowWrap = "anywhere";
  return made;
};
function action(key, handler, quiet = true) {
  const button = worded("button", key, quiet ? "quiet-button" : "");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { said = error.message; } finally { button.disabled = false; await refresh(); }
  });
  return button;
}
function field(id, key, control) {
  const label = worded("label", key);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
const safeId = (text) => text.replace(/[^\w-]/g, "-");

/** One card on Settings › Accounts; layout.js moves it there by its home. */
function card(id) {
  let found = $(id);
  if (found) return found;
  found = node("section", "card accounts-page-card");
  found.id = id;
  found.dataset.home = "settings:accounts";
  document.body.append(found);
  return found;
}

function modeControls(mode) {
  const select = node("select");
  for (const value of ["off", "when-needed", "on"]) {
    const option = worded("option", `accounts.switch.${value}`);
    option.value = value;
    select.append(option);
  }
  select.value = mode;
  select.addEventListener("change", async () => {
    try { await api("/settings", { mode: select.value }); said = t("accounts.saved"); } catch (error) { said = error.message; }
    await refresh();
  });
  return [...field("accounts-mode", "accounts.field.mode", select), worded("p", `accounts.mode.${mode}`, "field-note")];
}

/* ---------- one account ---------- */

function stateOf(pool, account) {
  if (account.disabled) return ["off", t("accounts.state.off")];
  if (account.capReached) return ["wait", t("accounts.state.cap")];
  if (account.limitedUntil) return ["wait", t("accounts.state.limit", { time: formatDate(account.limitedUntil, { timeStyle: "short" }) })];
  if (account.restingUntil) return ["wait", t("accounts.state.resting", { time: formatDate(account.restingUntil, { timeStyle: "short" }) })];
  if (pool.signedIn && pool.signedIn[account.id] === false)
    return ["off", pool.signInProblems?.[account.id] ? `${t("accounts.state.signed-out")} ${pool.signInProblems[account.id]}` : t("accounts.state.signed-out")];
  return ["ok", t("accounts.state.ready")];
}
function usageOf(pool, account) {
  const values = { count: formatNumber(account.usage.requests), tokens: formatNumber(account.usage.input + account.usage.output) };
  const text = pool.kind === "api-key"
    ? t("accounts.usage.cost", { ...values, cost: formatNumber(account.usage.costUsd, { style: "currency", currency: "USD" }) })
    : t("accounts.usage.plain", values);
  return account.remaining === null ? text : `${text} ${t("accounts.usage.left", { share: formatNumber(account.remaining) })}`;
}
/** A small ring for how much of the plan window is left, only where the service said. */
function ring(account) {
  if (account.remaining === null || account.remaining === undefined) return null;
  const share = Math.max(0, Math.min(100, Math.round(account.remaining)));
  const made = node("span", "accounts-ring");
  made.style.setProperty("--p", String(share));
  made.setAttribute("role", "img");
  made.setAttribute("aria-label", t("accounts.usage.left", { share: formatNumber(share) }));
  made.append(node("b", "", String(share)));
  return made;
}

function accountRow(pool, account) {
  const row = node("li", "accounts-row");
  row.dataset.account = account.id;
  row.dataset.find = `${account.label} ${pool.name}`.toLowerCase();
  const head = node("p", "accounts-row-head");
  head.append(data("strong", account.label), node("span", "", " "));
  if (account.id === pool.defaultAccount) head.append(worded("span", "accounts.badge.default", "subtle"));
  if (account.pinned) head.append(node("span", "", " "), worded("span", "accounts.badge.pinned", "subtle"));
  if (account.keptSeparate) head.append(node("span", "", " "), worded("span", "accounts.badge.kept-separate", "subtle"));
  const [tone, words] = stateOf(pool, account);
  const state = node("p", "subtle accounts-state", `${words} ${usageOf(pool, account)}`);
  state.dataset.tKey = "accounts.state";
  state.dataset.tone = tone;
  state.setAttribute("role", "status");
  const main = node("div", "accounts-row-main");
  main.append(node("span", `accounts-dot ${tone}`), head);
  const shown = ring(account);
  if (shown) main.append(shown);
  row.append(main, state);
  // Integration (hardening-3): a household person is shown the account, not the owner's buttons
  // (every change here is the owner's, and sign-in state is not sent to them).
  if (pool.strategy === undefined) return row;
  row.append(quickButtons(pool, account));
  if (pool.kind !== "api-key") row.append(separateBlock(pool, account));
  row.append(moreBlock(pool, account));
  return row;
}
/** What is done often stays in sight: new work, sign in or out, switch off or on. */
function quickButtons(pool, account) {
  const box = node("div", "identity-actions");
  if (account.id !== pool.defaultAccount)
    box.append(action("accounts.action.use", () => api("/switch", { pool: pool.pool, account: account.id })));
  if (pool.kind === "chatgpt" && account.id !== "primary") box.append(...signInButtons(pool, account));
  box.append(action(account.disabled ? "accounts.action.enable" : "accounts.action.disable",
    () => api("/update", { pool: pool.pool, account: account.id, disabled: !account.disabled })));
  return box;
}
/** Everything else for one account, folded away: name, order, pin, cap, the program's line, removing it. */
function moreBlock(pool, account) {
  const more = node("details", "accounts-more");
  const key = `${pool.pool}/${account.id}`;
  more.open = unfolded.has(key);
  more.addEventListener("toggle", () => { if (more.open) unfolded.add(key); else unfolded.delete(key); });
  more.append(worded("summary", "accounts.more"), renameBlock(pool, account));
  const update = (change) => () => api("/update", { pool: pool.pool, account: account.id, ...change });
  const box = node("div", "identity-actions");
  box.append(action("accounts.action.up", update({ move: "up" })), action("accounts.action.down", update({ move: "down" })),
    action(account.pinned ? "accounts.action.unpin" : "accounts.action.pin", update({ pinned: !account.pinned })));
  if (account.id !== "primary") box.append(action("accounts.action.remove", () => api("/remove", { pool: pool.pool, account: account.id })));
  more.append(box);
  if (pool.kind === "api-key") more.append(capBlock(pool, account));
  if (pool.kind === "cli" && account.home) more.append(programHelp(pool, account));
  return more;
}
function renameBlock(pool, account) {
  const box = node("div", "identity-actions");
  const input = node("input");
  input.value = account.label;
  input.maxLength = 60;
  box.append(...field(safeId(`accounts-name-${pool.pool}-${account.id}`), "accounts.field.name", input),
    action("accounts.action.rename", () => api("/update", { pool: pool.pool, account: account.id, label: input.value })));
  return box;
}
function signInButtons(pool, account) {
  if (pool.signedIn?.[account.id]) return [action("accounts.action.sign-out", () => api("/chatgpt/logout", { account: account.id }))];
  return [action("accounts.action.sign-in", async () => {
    const prompt = await api("/chatgpt/login", { account: account.id });
    said = t("accounts.sign-in.code", { code: prompt.userCode, url: prompt.verificationUrl });
    if (window.branchDesktop) window.branchDesktop.openExternal(prompt.verificationUrl).catch(() => undefined);
  })];
}
function capBlock(pool, account) {
  const box = node("div", "identity-actions");
  const cap = node("input");
  cap.type = "number"; cap.min = "0"; cap.step = "1";
  cap.value = account.monthlyCapUsd ?? "";
  const share = node("input");
  share.type = "checkbox";
  share.checked = account.shared;
  const shareLabel = node("label");
  shareLabel.append(share, worded("span", "accounts.field.shared"));
  share.addEventListener("change", async () => {
    try { await api("/update", { pool: pool.pool, account: account.id, shared: share.checked }); } catch (error) { said = error.message; }
    await refresh();
  });
  box.append(...field(safeId(`accounts-cap-${pool.pool}-${account.id}`), "accounts.field.cap", cap),
    action("accounts.action.save-cap", () => api("/update", { pool: pool.pool, account: account.id, monthlyCapUsd: cap.value === "" ? null : Number(cap.value) })),
    shareLabel);
  return box;
}
/** mac7/account-pooling: a sign-in that belongs to someone else or to work may share work with the owner's own. */
function separateBlock(pool, account) {
  const box = node("div", "identity-actions");
  const tick = node("input");
  tick.type = "checkbox";
  tick.checked = account.keptSeparate;
  // The words sit in their own span: applying a language rewrites a keyed node's text, which would drop the box.
  const label = node("label");
  label.append(tick, worded("span", "accounts.field.kept-separate"));
  tick.addEventListener("change", async () => {
    try { await api("/update", { pool: pool.pool, account: account.id, keptSeparate: tick.checked }); } catch (error) { said = error.message; }
    await refresh();
  });
  box.append(label);
  return box;
}
function programHelp(pool, account) {
  const box = node("div", "field-note");
  // Written by the server for this computer's own shell (PowerShell on Windows).
  box.append(worded("p", "accounts.program.sign-in"), data("code", account.signInLine || account.home));
  return box;
}

/* ---------- one connection ---------- */

function poolControls(pool) {
  const box = node("div", "identity-actions");
  if (pool.kind === "api-key") {
    const select = node("select");
    for (const value of ["priority", "round-robin", "least-used"]) {
      const option = worded("option", `accounts.strategy.${value}`);
      option.value = value;
      select.append(option);
    }
    select.value = pool.strategy;
    select.addEventListener("change", () => void api("/pool", { pool: pool.pool, strategy: select.value }).catch((e) => { said = e.message; }).then(refresh));
    box.append(...field(safeId(`accounts-strategy-${pool.pool}`), "accounts.field.strategy", select));
    return box;
  }
  const tick = node("input");
  tick.type = "checkbox";
  tick.checked = pool.autoSwitch;
  const label = node("label");
  label.append(tick, " ", worded("span", "accounts.field.auto-switch"));
  tick.addEventListener("change", () => void api("/pool", { pool: pool.pool, autoSwitch: tick.checked }).catch((e) => { said = e.message; }).then(refresh));
  box.append(label, worded("p", "accounts.auto-switch.risk", "field-note"));
  return box;
}
function addBlock(pool) {
  const box = node("div", "identity-actions accounts-add");
  const label = node("input");
  label.maxLength = 60;
  const base = safeId(`accounts-add-${pool.pool}`);
  box.append(...field(`${base}-name`, "accounts.field.new-name", label));
  let key = null;
  if (pool.kind === "api-key") {
    key = node("input");
    key.type = "password";
    key.autocomplete = "off";
    box.append(...field(`${base}-key`, "accounts.field.key", key));
  }
  box.append(action("accounts.action.add", async () => {
    await api("/add", { pool: pool.pool, label: label.value, ...(key ? { key: key.value } : {}) });
    said = t("accounts.added");
  }, false));
  return box;
}
function termsLine(pool) {
  const line = node("p", "subtle terms-line");
  line.append(worded("strong", "terms.label"), node("span", "", " "), worded("span", pool.terms.key), node("span", "", " "));
  for (const link of pool.terms.links) {
    const anchor = worded("a", "terms.read");
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.title = link.label;
    line.append(anchor, node("span", "", " "));
  }
  return line;
}
function poolHead(pool) {
  const head = node("div", "accounts-pool-head");
  const heading = node("h3");
  heading.append(data("span", pool.name), node("span", "", " · "), worded("span", `accounts.kind.${pool.kind}`));
  head.append(markTile([pool.pool, pool.name], { size: 32, label: pool.name }), heading,
    worded("span", "accounts.count", "subtle accounts-count", { count: formatNumber(pool.accounts.length) }));
  return head;
}
function poolBlock(pool) {
  const box = node("div", "card-row accounts-pool");
  box.dataset.pool = pool.pool;
  const list = node("ul", "accounts-list");
  list.append(...pool.accounts.map((account) => accountRow(pool, account)));
  box.append(poolHead(pool));
  if (pool.notice) box.append(noticeBlock(pool));
  // hardening-3: a household person is sent only the accounts shared with them, not how the list is run.
  // The owner's lists always carry a strategy (it has a default in src/accounts/settings.ts).
  const owners = pool.strategy !== undefined;
  box.append(...(owners ? [poolControls(pool)] : []), list, ...(owners ? [addBlock(pool)] : []), termsLine(pool));
  return box;
}
/** mac7/account-pooling: said once, why sharing between the owner's own plans stopped. */
function noticeBlock(pool) {
  const box = node("div", "field-note accounts-notice");
  const words = worded("p", pool.notice.key, "", { service: pool.notice.service });
  words.setAttribute("role", "status");
  box.append(words, action("accounts.action.dismiss-notice", () => api("/notice", { pool: pool.pool }), false));
  return box;
}

/** Hides rows (and connections left empty) that do not match the search; nothing is fetched again. */
function applySearch() {
  const words = query.trim().toLowerCase();
  for (const pool of document.querySelectorAll("#accounts-card .accounts-pool")) {
    let any = false;
    for (const row of pool.querySelectorAll(".accounts-row")) { row.hidden = Boolean(words) && !row.dataset.find.includes(words); any ||= !row.hidden; }
    pool.hidden = Boolean(words) && !any;
  }
}
function searchBox(view) {
  const total = view.pools.reduce((sum, pool) => sum + pool.accounts.length, 0);
  if (total <= 6) return [];
  const input = node("input", "accounts-search");
  input.type = "search";
  input.value = query;
  input.placeholder = t("accounts.search");
  input.dataset.tPlaceholder = "accounts.search";
  input.setAttribute("aria-label", t("accounts.search"));
  input.dataset.tLabel = "accounts.search";
  input.addEventListener("input", () => { query = input.value; applySearch(); });
  return [input];
}

function draw(view) {
  const target = card("accounts-card");
  const status = node("p", "subtle", said);
  status.setAttribute("role", "status");
  target.replaceChildren(worded("h2", "settings.card.accounts"), worded("p", "accounts.lead"),
    worded("p", "accounts.honest", "accounts-honest"), ...modeControls(view.mode), status);
  if (view.mode === "off") { $("accounts-low-card")?.remove(); $("accounts-trunks-card")?.remove(); return; }
  if (!view.pools.length) target.append(worded("p", "accounts.empty", "empty-state"));
  target.append(...searchBox(view), ...view.pools.map(poolBlock));
  applySearch();
  // hardening-3: someone else is sent lists without how they are run; the fallback order and the Trunks are the owner's.
  if (view.pools.some((pool) => pool.strategy === undefined)) { $("accounts-low-card")?.remove(); $("accounts-trunks-card")?.remove(); return; }
  drawLow(view);
  void drawTrunks(view);
}

/* ---------- when one runs low ---------- */

function drawLow(view) {
  const target = card("accounts-low-card");
  const models = globalThis.branchModelsNow;
  const names = new Map((models?.presets ?? []).map((preset) => [preset.id, preset]));
  const order = (models?.fallbackOrder ?? []).map((id) => names.get(id)).filter(Boolean);
  const list = node("ol", "accounts-fallback");
  for (const preset of order) {
    const item = node("li");
    item.append(markTile([preset.id, preset.name, preset.model], { size: 24 }), data("span", `${preset.name} · ${preset.model}`));
    list.append(item);
  }
  const change = worded("button", "accounts.low.change", "quiet-button");
  change.type = "button";
  change.addEventListener("click", () => globalThis.branchLayout?.go("settings:models"));
  target.replaceChildren(worded("h2", "accounts.low.title"), worded("p", "accounts.low.inside"),
    worded("p", "accounts.low.between"), order.length ? list : worded("p", "accounts.low.none", "subtle"), change);
  target.hidden = !view.pools.length;
}

/* ---------- which key each Trunk uses ---------- */

function trunkRow(trunk, pools) {
  const row = node("li", "accounts-trunk");
  row.dataset.trunk = trunk.id;
  row.append(data("strong", trunk.name));
  for (const pool of pools) {
    const select = node("select");
    const mine = worded("option", trunk.keys.copyFromOwner ? "accounts.trunks.default" : "accounts.trunks.none-picked");
    mine.value = "";
    select.append(mine, ...pool.accounts.filter((account) => !account.disabled).map((account) => {
      const option = data("option", account.label);
      option.value = account.id;
      return option;
    }));
    select.value = trunk.keys.accounts[pool.pool] ?? "";
    select.addEventListener("change", async () => {
      const accounts = { ...trunk.keys.accounts };
      if (select.value) accounts[pool.pool] = select.value; else delete accounts[pool.pool];
      try { await request(`/api/trunks/${trunk.id}`, { keys: { copyFromOwner: trunk.keys.copyFromOwner, accounts } }); said = t("accounts.trunks.saved"); }
      catch (error) { said = error.message; }
      await refresh();
    });
    const wrap = node("div", "accounts-trunk-pick");
    const label = worded("label", "accounts.trunks.for", "", { service: pool.name });
    label.htmlFor = select.id = safeId(`accounts-trunk-${trunk.id}-${pool.pool}`);
    wrap.append(label, select);
    row.append(wrap);
  }
  return row;
}
async function drawTrunks(view) {
  const pools = view.pools.filter((pool) => pool.kind === "api-key" && pool.accounts.length);
  let roster = null;
  try { roster = await request("/api/trunks"); } catch { roster = null; }
  const target = card("accounts-trunks-card");
  target.replaceChildren(worded("h2", "accounts.trunks.title"), worded("p", "accounts.trunks.lead"));
  const trunks = roster?.modes?.trunks === "off" ? [] : roster?.trunks ?? [];
  if (!trunks.length) { target.append(worded("p", "accounts.trunks.none", "subtle")); return; }
  if (!pools.length) { target.append(worded("p", "accounts.trunks.no-keys", "subtle")); return; }
  const list = node("ul", "accounts-trunks");
  list.append(...trunks.map((trunk) => trunkRow(trunk, pools)));
  target.append(list);
}

/* ---------- the chip in the title bar ---------- */
function chip() {
  let found = $("accounts-chip");
  if (found) return found;
  const anchor = $("lx-crumb") ?? $("page-title");
  if (!anchor) return null;
  found = node("span", "accounts-chip");
  found.id = "accounts-chip";
  found.hidden = true;
  anchor.after(found);
  return found;
}
async function drawChip() {
  const holder = chip();
  if (!holder || !token()) return;
  const sessionId = $("conversation")?.dataset.sessionId || "";
  let view;
  try { view = await api(`/session?sessionId=${encodeURIComponent(sessionId)}`); } catch { holder.hidden = true; return; }
  holder.hidden = !view.pool;
  if (!view.pool) return;
  const select = node("select");
  select.id = "accounts-chip-select";
  select.setAttribute("aria-label", t("accounts.chip.label"));
  select.dataset.tLabel = "accounts.chip.label";
  for (const account of view.accounts) {
    const option = data("option", account.label);
    option.value = account.id;
    select.append(option);
  }
  select.value = view.account;
  select.addEventListener("change", async () => {
    try { await api("/switch", { pool: view.pool, account: select.value, ...(sessionId ? { sessionId } : {}) }); }
    catch (error) { said = error.message; }
    await refresh();
  });
  holder.replaceChildren(select);
}

async function refresh() {
  if (!token()) return;
  try {
    last = await api();
    draw(last);
  } catch { /* signed out, or this launch has no accounts: the next look tries again */ }
  said = "";
  await drawChip();
}

void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh(); });
document.addEventListener("branch-language", () => { if (last) draw(last); void drawChip(); });
document.addEventListener("branch-models", () => { if (last && last.mode !== "off") drawLow(last); });
/** The workspace shows a moment before the key is kept, so wait for the key before the first look. */
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !token(); left--) await new Promise((done) => setTimeout(done, 250));
  await refresh();
}
const workspace = $("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) void afterSignIn(); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
const conversation = $("conversation");
if (conversation) new MutationObserver(() => void drawChip()).observe(conversation, { attributes: true, attributeFilter: ["data-session-id"] });
const provider = $("context-provider");
if (provider) new MutationObserver(() => void drawChip()).observe(provider, { childList: true, characterData: true, subtree: true });
window.branchAccounts = { refresh };
