/**
 * "Plan first, show me the plan, then act." The switch in the conversation, above the model
 * picker, chooses between just doing it and being shown a plan first, and says how far a task may
 * go before it checks back. The card below shows the plan in plain words: what each step will do,
 * what it touches, which of them change something, and where the work has got to.
 *
 * Both choices belong to this conversation. One button puts the same choice on the whole project.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const session = () => $("conversation")?.dataset.sessionId || "";
const say = (message) => { const box = $("plan-mode-state"); if (box) box.textContent = message; };
const STATUS = { waiting: "planAct.waiting", working: "planAct.doing", done: "planAct.done", failed: "planAct.failed" };

function button(label, className, handler) {
  const node = el("button", label, className);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}
/** One step: where it has got to, what it says, what it touches, and whether it changes anything. */
function stepRow(step, at, editable) {
  const row = el("li", undefined, "plan-step");
  row.dataset.status = step.status || "waiting";
  row.append(el("span", t(STATUS[step.status] || STATUS.waiting), "plan-step-status"));
  if (editable) {
    const field = el("input");
    field.type = "text";
    field.maxLength = 200;
    field.value = step.title;
    field.className = "plan-step-title";
    field.setAttribute("aria-label", t("planAct.stepWording", { number: at }));
    row.append(field);
  } else row.append(el("span", `${at}. ${step.title}`, "plan-step-title"));
  if (step.touches) row.append(el("small", step.touches, "plan-step-touches"));
  if (step.changes === false) row.append(el("small", t("planAct.changesNothing"), "plan-step-touches"));
  return row;
}
/** The plan as a card: the steps, the one sentence about the risky ones, and what you can do. */
function planCard(plan, risk) {
  const card = $("plan-card");
  const waiting = plan.decision === "waiting" || (!plan.approved && plan.decision !== "rejected");
  const list = el("ol", undefined, "plan-steps");
  for (const [at, step] of plan.steps.entries()) list.append(stepRow(step, at + 1, waiting));
  card.replaceChildren(el("h3", t("planAct.title")), el("p", risk, "meta"), list);
  if (waiting) card.append(...decideRow(plan, list));
  else if (plan.decision === "rejected") card.append(el("p", t("planAct.sentBack"), "meta"));
  else card.append(el("p", t("planAct.agreed"), "meta"),
    button(t("planAct.goAhead"), "text-button", () => carryOn()));
  card.hidden = false;
}
/** Yes, or no with a reason. Yes is one press; the wording you changed is what runs. */
function decideRow(plan, list) {
  const reason = el("input");
  reason.type = "text";
  reason.id = "plan-reject-reason";
  reason.maxLength = 500;
  reason.placeholder = t("planAct.reason");
  reason.setAttribute("aria-label", t("planAct.reason"));
  const yes = button(t("planAct.approve"), "", () => decide(plan, "approve", list, ""));
  yes.id = "plan-approve";
  const no = button(t("planAct.sendBack"), "danger", () => decide(plan, "reject", list, reason.value.trim()));
  no.id = "plan-reject";
  return [el("p", t("planAct.nothingYet"), "meta"), yes, reason, no];
}
async function decide(plan, decision, list, reason) {
  const steps = [...list.querySelectorAll(".plan-step")].map((row, at) => {
    const field = row.querySelector("input.plan-step-title");
    const title = (field?.value || plan.steps[at].title).trim();
    const step = plan.steps[at];
    return { title: title.length >= 2 ? title : step.title,
      ...(step.touches ? { touches: step.touches } : {}), changes: step.changes !== false };
  });
  try {
    await api(`runs/${plan.runId}/plan`, decision === "reject"
      ? { decision: "reject", ...(reason ? { reason } : {}) } : { steps });
    say(decision === "reject" ? t("planAct.sentBack") : t("planAct.agreed"));
    await render();
  } catch (error) { say(error.message); }
}
/** "Go ahead" is an ordinary message, so it travels the path every other message does. */
function carryOn() {
  const box = $("prompt");
  if (!box) return;
  box.value = "go ahead";
  $("chat-form")?.requestSubmit();
}
/**
 * Saves the choice for this conversation, or for every conversation in the project. Before the
 * first message there is no conversation to set apart, so the choice is the project's.
 */
async function choose(wanted) {
  const sessionId = session();
  const scope = sessionId ? wanted : "project";
  try {
    const body = { planMode: $("session-plan-mode").value, autonomy: $("session-autonomy").value, scope };
    await api("plan-act", { ...body, ...(sessionId ? { sessionId } : {}) });
    say(scope === "project" ? t("planAct.savedProject") : t("planAct.savedConversation"));
    await render();
  } catch (error) { say(error.message); }
}
/** Draws the switch and the card from what the server says, for whichever conversation is open. */
export async function render() {
  if (!$("session-plan-mode")) return;
  const sessionId = session();
  let state;
  try { state = await api(`plan-act${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`); }
  catch { return; }
  $("session-plan-mode").value = state.effective.planMode;
  $("session-autonomy").value = state.effective.autonomy;
  const plan = state.plan;
  if (!plan || plan.mode !== "show-plan") { $("plan-card").hidden = true; $("plan-card").replaceChildren(); }
  else planCard(plan, riskLine(plan));
  keepLooking();
}
/** The one sentence about which steps change something, in the language the page is showing. */
function riskLine(plan) {
  const risky = plan.steps.map((step, at) => ({ step, at: at + 1 })).filter((one) => one.step.changes !== false);
  if (!risky.length) return t("planAct.riskNone");
  const steps = risky.map((one) => `${one.at} (${one.step.touches || one.step.title})`).join(", ");
  return t(risky.length === 1 ? "planAct.riskOne" : "planAct.riskSome", { steps });
}
/**
 * Looking for a plan costs a small request, so it is only done while one could appear: for a minute
 * after you send something, and for as long as a plan card is on the screen. A conversation in
 * "Just do it" settles back to asking nothing at all.
 */
let ticker = null, watchUntil = 0;
function keepLooking() {
  const wanted = !$("plan-card")?.hidden || Date.now() < watchUntil;
  if (wanted && !ticker) ticker = setInterval(() => { if (!document.hidden) void render(); }, 2000);
  if (!wanted && ticker) { clearInterval(ticker); ticker = null; }
}
$("session-plan-mode")?.addEventListener("change", () => void choose("conversation"));
$("session-autonomy")?.addEventListener("change", () => void choose("conversation"));
$("plan-mode-project")?.addEventListener("click", () => void choose("project"));
$("chat-form")?.addEventListener("submit", () => { watchUntil = Date.now() + 60000; keepLooking(); });
document.addEventListener("branch-language", () => void render());
/* The choices are read once the key is given; before that the selects showed their first option, not the saved one. */
if ($("workspace"))
  new MutationObserver(() => { if (!$("workspace").hidden) void render(); }).observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
/* Opening another conversation changes this one attribute, and the card belongs to that one. */
if ($("conversation"))
  new MutationObserver(() => void render()).observe($("conversation"), { attributeFilter: ["data-session-id"] });
globalThis.branchPlanAct = { render };
void render();
