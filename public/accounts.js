// Several accounts per connection (mac6/accounts). One Settings card with the three-way switch and a
// list per connection; ChatGPT's list sits inside the ChatGPT card. A chip in the title bar names the
// account the conversation's model answers through. Keys and sign-ins never reach this page.
import { t, formatNumber, formatDate } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => { try { return sessionStorage.getItem("branch-token") || ""; } catch { return ""; } };
let said = "";
let last = null;

async function api(path = "", body) {
  const response = await fetch("/api/accounts" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

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

function card() {
  let found = $("accounts-card");
  if (found) return found;
  const anchor = $("chatgpt-card");
  if (!anchor) return null;
  found = node("section", "card");
  found.id = "accounts-card";
  found.dataset.home = "settings:models:connection";
  anchor.after(found);
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

function statusOf(pool, account) {
  if (account.disabled) return t("accounts.state.off");
  if (account.capReached) return t("accounts.state.cap");
  if (account.limitedUntil) return t("accounts.state.limit", { time: formatDate(account.limitedUntil, { timeStyle: "short" }) });
  if (account.restingUntil) return t("accounts.state.resting", { time: formatDate(account.restingUntil, { timeStyle: "short" }) });
  if (pool.signedIn && pool.signedIn[account.id] === false)
    return pool.signInProblems?.[account.id] ? `${t("accounts.state.signed-out")} ${pool.signInProblems[account.id]}` : t("accounts.state.signed-out");
  return t("accounts.state.ready");
}
function usageOf(pool, account) {
  const values = { count: formatNumber(account.usage.requests), tokens: formatNumber(account.usage.input + account.usage.output) };
  const text = pool.kind === "api-key"
    ? t("accounts.usage.cost", { ...values, cost: formatNumber(account.usage.costUsd, { style: "currency", currency: "USD" }) })
    : t("accounts.usage.plain", values);
  return account.remaining === null ? text : `${text} ${t("accounts.usage.left", { share: formatNumber(account.remaining) })}`;
}

function accountRow(pool, account) {
  const row = node("li", "accounts-row");
  row.dataset.account = account.id;
  const head = node("p");
  head.append(data("strong", account.label), node("span", "", " "));
  if (account.id === pool.defaultAccount) head.append(worded("span", "accounts.badge.default", "subtle"));
  if (account.pinned) head.append(node("span", "", " "), worded("span", "accounts.badge.pinned", "subtle"));
  if (account.keptSeparate) head.append(node("span", "", " "), worded("span", "accounts.badge.kept-separate", "subtle"));
  const state = node("p", "subtle", `${statusOf(pool, account)} ${usageOf(pool, account)}`);
  state.dataset.tKey = "accounts.state";
  state.setAttribute("role", "status");
  row.append(head, state, renameBlock(pool, account), buttonsFor(pool, account));
  if (pool.kind === "api-key") row.append(capBlock(pool, account));
  else row.append(separateBlock(pool, account));
  if (pool.kind === "cli" && account.home) row.append(programHelp(pool, account));
  return row;
}
function renameBlock(pool, account) {
  const box = node("div", "identity-actions");
  const input = node("input");
  input.value = account.label;
  input.maxLength = 60;
  const id = `accounts-name-${pool.pool}-${account.id}`.replace(/[^\w-]/g, "-");
  box.append(...field(id, "accounts.field.name", input),
    action("accounts.action.rename", () => api("/update", { pool: pool.pool, account: account.id, label: input.value })));
  return box;
}
function buttonsFor(pool, account) {
  const box = node("div", "identity-actions");
  const update = (change) => () => api("/update", { pool: pool.pool, account: account.id, ...change });
  box.append(
    action("accounts.action.up", update({ move: "up" })),
    action("accounts.action.down", update({ move: "down" })),
    action(account.pinned ? "accounts.action.unpin" : "accounts.action.pin", update({ pinned: !account.pinned })),
    action(account.disabled ? "accounts.action.enable" : "accounts.action.disable", update({ disabled: !account.disabled })),
  );
  if (account.id !== pool.defaultAccount)
    box.append(action("accounts.action.use", () => api("/switch", { pool: pool.pool, account: account.id })));
  if (pool.kind === "chatgpt" && account.id !== "primary") box.append(...signInButtons(pool, account));
  if (account.id !== "primary") box.append(action("accounts.action.remove", () => api("/remove", { pool: pool.pool, account: account.id })));
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
  const id = `accounts-cap-${pool.pool}-${account.id}`.replace(/[^\w-]/g, "-");
  const share = node("input");
  share.type = "checkbox";
  share.checked = account.shared;
  const shareLabel = node("label");
  shareLabel.append(share, worded("span", "accounts.field.shared"));
  share.addEventListener("change", async () => {
    try { await api("/update", { pool: pool.pool, account: account.id, shared: share.checked }); } catch (error) { said = error.message; }
    await refresh();
  });
  box.append(...field(id, "accounts.field.cap", cap),
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
    box.append(...field(`accounts-strategy-${pool.pool}`.replace(/[^\w-]/g, "-"), "accounts.field.strategy", select));
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
  const box = node("div", "identity-actions");
  const label = node("input");
  label.maxLength = 60;
  const base = `accounts-add-${pool.pool}`.replace(/[^\w-]/g, "-");
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
function poolBlock(pool) {
  const box = node("div", "card-row accounts-pool");
  box.dataset.pool = pool.pool;
  const heading = node("h3");
  heading.append(data("span", pool.name), node("span", "", " · "), worded("span", `accounts.kind.${pool.kind}`));
  const list = node("ul", "accounts-list");
  list.append(...pool.accounts.map((account) => accountRow(pool, account)));
  box.append(heading);
  if (pool.notice) box.append(noticeBlock(pool));
  box.append(poolControls(pool), list, addBlock(pool), termsLine(pool));
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

function draw(view) {
  const target = card();
  if (!target) return;
  const status = node("p", "subtle", said);
  status.setAttribute("role", "status");
  target.replaceChildren(worded("h2", "settings.card.accounts"), worded("p", "accounts.lead"), ...modeControls(view.mode), status);
  $("accounts-in-chatgpt")?.remove();
  if (view.mode === "off") return;
  const pools = view.pools.filter((pool) => pool.kind !== "chatgpt");
  if (!pools.length && !view.pools.length) target.append(worded("p", "accounts.empty", "empty-state"));
  target.append(...pools.map(poolBlock));
  const chatgpt = view.pools.find((pool) => pool.kind === "chatgpt");
  if (chatgpt && $("chatgpt-card")) {
    const inner = node("div");
    inner.id = "accounts-in-chatgpt";
    inner.append(poolBlock(chatgpt));
    $("chatgpt-card").append(inner);
  }
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
