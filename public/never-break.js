// Keeping Branch running (mac3/never-break). One Settings card: the three-way switch for the
// gateway, what it has been doing, and a change the assistant suggested for it, which only the owner
// can accept. The deciding happens on the server (src/never-break/); every word is behind a key.
import { t, formatNumber } from "/i18n.js";

const $ = (id) => document.getElementById(id);
/** A sentence to show under the switch after the card is drawn again. */
let said = "";

async function api(path = "", body) {
  const response = await fetch("/api/never-break" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
/** The gateway answers for itself, without the engine, when Branch runs behind one. */
async function gatewayHealth() {
  const response = await fetch("/gateway/health").catch(() => null);
  return response && response.ok ? response.json().catch(() => null) : null;
}

function worded(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  node.style.overflowWrap = "anywhere";
  return node;
}
function statusLine() {
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  return status;
}

function card() {
  let node = $("never-break-card");
  if (node) return node;
  const after = $("deployment-card");
  if (!after) return null;
  node = document.createElement("section");
  node.className = "card";
  node.id = "never-break-card";
  node.dataset.home = "settings:general";
  after.after(node);
  return node;
}

function modeControls(mode) {
  const label = worded("label", "field.never-break-mode");
  label.htmlFor = "never-break-mode";
  const select = document.createElement("select");
  select.id = "never-break-mode";
  for (const value of ["off", "when-needed", "on"]) {
    const option = worded("option", `never-break.switch.${value}`);
    option.value = value;
    select.append(option);
  }
  select.value = mode;
  const status = statusLine();
  status.textContent = said;
  said = "";
  const button = worded("button", "action.save-this-setting");
  button.type = "button";
  button.addEventListener("click", async () => {
    try { await api("", { mode: select.value }); said = t("never-break.saved"); await refresh(); }
    catch (error) { status.textContent = error.message; }
  });
  return [label, select, worded("p", `never-break.mode.${mode}`, "field-note"), button, status];
}

function nowLine(view, health) {
  if (health && health.worker) {
    const key = health.worker.state === "ready" ? "never-break.now.running" : "never-break.now.restarting";
    return worded("p", key, "subtle", { count: formatNumber(health.restarts || 0) });
  }
  return worded("p", view.mode === "off" ? "never-break.now.off" : "never-break.now.next-start", "subtle");
}

function proposalBlock(proposal) {
  const box = document.createElement("div");
  box.className = "card-row";
  const heading = worded("h4", "never-break.proposal.title");
  const tried = proposal.check && proposal.check.ok ? "never-break.proposal.tried-ok" : "never-break.proposal.tried-bad";
  const status = statusLine();
  const row = document.createElement("div");
  row.className = "identity-actions";
  const accept = worded("button", "action.use-this-change", "quiet-button");
  accept.type = "button";
  accept.disabled = !(proposal.check && proposal.check.ok);
  const discard = worded("button", "action.discard-this-change", "quiet-button");
  discard.type = "button";
  for (const [button, path] of [[accept, "/proposal/accept"], [discard, "/proposal/discard"]])
    button.addEventListener("click", async () => {
      try { await api(path, {}); await refresh(); } catch (error) { status.textContent = error.message; }
    });
  row.append(accept, discard);
  box.append(heading, plain("p", proposal.why), worded("p", tried, "subtle"),
    plain("p", (proposal.check && proposal.check.detail) || "", "subtle"), row, status);
  return box;
}

function draw(view, health) {
  const node = card();
  if (!node) return;
  node.replaceChildren(worded("h2", "settings.card.keep-running"), worded("p", "never-break.lead"),
    ...modeControls(view.mode), nowLine(view, health));
  if (view.problem) node.append(plain("p", view.problem, "subtle"));
  if (view.proposal) node.append(proposalBlock(view.proposal));
  node.append(worded("p", "never-break.next-start", "subtle"));
}

async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try {
    const [view, health] = await Promise.all([api(), gatewayHealth()]);
    last = [view, health];
    draw(view, health);
  } catch { /* signed out or offline: the next look tries again */ }
}

async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

// Looked at when the page opens, after each answer, and when the owner comes back to the window.
let last = null;
const redraw = () => { if (last) draw(...last); };
void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refresh(); });
document.addEventListener("branch-language", redraw);
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchNeverBreak = { refresh };
