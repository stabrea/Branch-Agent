/**
 * Two small things in the sidebar. Lockdown is one switch that makes everything wait for a yes and
 * turns off everything that reaches past this app; while it is on the sidebar says so, and turning
 * it off puts back exactly the settings that were there before. Below it, when the conversation you
 * are reading came off another one — or has others off it — the shape is drawn as a short list, and
 * a branch's last answer can be carried back into the conversation it came from as a note.
 */
import { t } from "./i18n.js";
import { openConversation } from "/app.js";

const $ = (id) => document.getElementById(id);
const say = (message) => (globalThis.toast ? globalThis.toast(message) : console.warn(message));
/** The conversation being read, as the conversation column itself records it. */
const currentSession = () => $("conversation")?.dataset.sessionId || "";
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

/* ---- Lockdown ---- */

/** The one switch, with a plain line under it saying what it stops. */
async function renderLockdown() {
  const host = $("lockdown-panel");
  if (!host) return;
  let state;
  try { state = await api("lockdown"); } catch { host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren();
  const button = el("button", state.on ? "Lockdown is on — turn it off" : "Turn on Lockdown", "rail-row");
  button.type = "button";
  button.setAttribute("aria-pressed", String(Boolean(state.on)));
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api("lockdown", { on: !state.on }); }
    catch (error) { say("That could not be changed: " + error.message); }
    await renderLockdown();
  });
  host.append(button, el("p", state.on
    ? state.effects.join(" ")
    : "One switch: commands, programs and your screen are refused without asking, everything else waits for your yes, and nothing is sent out.",
    "muted"));
}

/* ---- The shape branched conversations make ---- */

/** One line per conversation in the shape, indented by how deep it sits. */
function treeRows(node, depth, current, into) {
  const row = el("button", `${"— ".repeat(depth)}${node.title}`, "rail-row");
  row.type = "button";
  row.title = `${node.messages} message(s)`;
  if (node.sessionId === current) row.setAttribute("aria-current", "true");
  row.addEventListener("click", () => void openConversation(node.sessionId));
  into.append(row);
  for (const child of node.children ?? []) treeRows(child, depth + 1, current, into);
}

/** The whole shape for the conversation being read; hidden when it stands on its own. */
async function renderTree(sessionId) {
  const host = $("branch-tree");
  if (!host) return;
  if (!sessionId) { host.hidden = true; return; }
  let tree;
  try { tree = await api(`sessions/${sessionId}/tree`); } catch { host.hidden = true; return; }
  if (!tree.children?.length && tree.sessionId === sessionId) { host.hidden = true; return; }
  host.hidden = false;
  host.replaceChildren(el("h3", "This conversation and its branches"));
  treeRows(tree, 0, sessionId, host);
  if (tree.sessionId !== sessionId) host.append(carryBack(sessionId));
}

/** Writes this branch's last answer back into the conversation it came off, as one note. */
function carryBack(sessionId) {
  const button = el("button", t("other.action.carryBack"), "rail-row");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`sessions/${sessionId}/merge-note`, {});
      button.textContent = t("other.status.carriedBack");
    } catch (error) {
      button.textContent = t("other.status.didNotWork");
      say(error.message);
    }
  });
  return button;
}

/** Everything this file draws. Safe to call again at any time. */
async function render(sessionId) {
  await Promise.allSettled([renderLockdown(), renderTree(sessionId ?? currentSession())]);
}
window.branchOther = { render, renderLockdown, renderTree };
