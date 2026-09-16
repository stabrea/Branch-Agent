/**
 * "What is allowed right now": the yeses this conversation is carrying and the standing rules that
 * apply to it, each with when it runs out and a one-click way to take it back. It reads
 * `GET /api/rules/allowed` and writes through `POST /api/rules/allowed/revoke`.
 *
 * The same words are used on the approval card, so before you press "Yes" you can see exactly what
 * the yes will leave behind.
 */
import { t, formatDate } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
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

/** What a yes leaves behind, in the words the "What is allowed" list uses for the same thing. */
export function grantSentence(remember) {
  if (remember === "always") return t("allowed.grantAlways");
  if (remember === "session") return t("allowed.grantSession");
  return t("allowed.grantOnce");
}

/** One remembered yes, with when it runs out and the button that takes it back. */
function grantRow(sessionId, grant, redraw) {
  const node = el("div", undefined, "context-row allowed-row");
  node.dataset.tool = grant.tool;
  node.append(el("strong", grant.label || grant.tool));
  node.append(el("span", [t("allowed.session"), t("allowed.until", { time: formatDate(grant.expiresAt, { timeStyle: "short" }) })].join(" · "), "meta"));
  const revoke = el("button", t("allowed.revoke"), "text-button allowed-revoke");
  revoke.type = "button";
  revoke.addEventListener("click", async () => {
    revoke.disabled = true;
    try {
      await api("rules/allowed/revoke", { session: sessionId, tool: grant.tool, target: grant.target });
      globalThis.toast?.(t("allowed.revoke"));
    } catch (error) { globalThis.toast?.(error.message); }
    await redraw();
  });
  node.append(revoke);
  return node;
}

/** One standing rule that says "go ahead". It is changed in the approval settings, not here. */
function standingRow(entry) {
  const node = el("div", undefined, "context-row allowed-row");
  node.append(el("strong", entry.sentence));
  node.append(el("span", t("allowed.standing"), "meta"));
  return node;
}

/**
 * Draws the list into `target` for one conversation. With no conversation open, or nothing
 * allowed, it says so in a sentence rather than showing an empty box.
 */
export async function drawAllowed(target, sessionId) {
  if (!target) return { grants: [], standing: [] };
  const redraw = () => drawAllowed(target, sessionId);
  let view = { grants: [], standing: [] };
  try {
    view = await api("rules/allowed?session=" + encodeURIComponent(sessionId || ""));
  } catch { /* the pane keeps whatever it last showed */ }
  const rows = [
    ...view.grants.map((grant) => grantRow(sessionId, grant, redraw)),
    ...(view.standing ?? []).map(standingRow),
  ];
  target.replaceChildren(...(rows.length ? rows : [el("p", t("allowed.none"), "context-empty")]));
  return view;
}

globalThis.branchAllowed = { draw: drawAllowed, grantSentence };
