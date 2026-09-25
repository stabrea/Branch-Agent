/**
 * While your assistant is working, this is the row that tells you so — what step it has reached,
 * how long it has been going, how much context it has used — and lets you step in: hold it, tell it
 * something, or stop it. When it stops to ask whether it may go ahead, the question appears right
 * here as a card with the four honest answers.
 *
 * Live steps arrive over the same WebSocket the rest of the app uses; if the socket cannot be
 * opened it falls back to asking the activity route every second.
 */
import { t, formatNumber } from "/i18n.js";
import { taskWords } from "/task-state.js"; // Q51
/* Wave 7: the same words the "What is allowed right now" list uses for what a yes leaves behind. */
import { grantSentence } from "/allowed.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const token = () => sessionStorage.getItem("branch-token") || "";
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

let watching = null;

function button(label, className, handler) {
  const node = el("button", label, className);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}
/** The one row of controls: hold, tell it something, stop. */
function controls(runId) {
  const row = el("div", undefined, "live-controls");
  /* Holding and letting go are both notes to a task that is still working: a run is only ever
     "resumed" after it has stopped, so neither of these touches the resume route. */
  const pause = button(t("live.pause"), "text-button", async () => {
    const holding = pause.dataset.holding === "1";
    try {
      await api(`runs/${runId}/steer`, {
        text: holding
          ? "Carry on with what you were doing."
          : "Hold here and wait for me before doing anything else.",
      });
      pause.dataset.holding = holding ? "0" : "1";
      pause.textContent = holding ? t("live.pause") : t("live.resume");
      status(holding ? t("live.resumed") : t("live.paused"));
    } catch (error) { status(error.message); }
  });
  pause.id = "live-pause";
  const steer = button(t("live.steer"), "text-button", () => {
    const box = $("live-steer-box");
    box.hidden = !box.hidden;
    if (!box.hidden) $("live-steer-text").focus();
  });
  steer.id = "live-steer";
  const stop = button(t("live.stop"), "text-button danger", async () => {
    try { await api(`runs/${runId}/cancel`, {}); status(t("live.stopped")); }
    catch (error) { status(error.message); }
  });
  stop.id = "live-stop";
  row.append(pause, steer, stop);
  return row;
}
const status = (message) => { $("live-status").textContent = message; };

/* mac7/multi-target: every file a question's call touches, the first few named and the rest folded away. */
function filesBlock(question, tone) {
  const files = Array.isArray(question.files) ? question.files : [];
  if (files.length < 2) return null;
  const line = (file) => el("li", t(file.kind === "read" ? "live.fileRead" : file.kind === "delete" ? "live.fileDelete" : "live.fileWrite", { path: file.path }));
  const shown = el("ul");
  for (const file of files.slice(0, 5)) shown.append(line(file));
  const box = el("div");
  box.append(el("p", t("live.files", { count: files.length }), tone), shown);
  if (files.length > 5) {
    const more = el("details"), rest = el("ul");
    for (const file of files.slice(5)) rest.append(line(file));
    more.append(el("summary", t("live.filesMore", { count: files.length - 5 })), rest);
    box.append(more);
  }
  return box;
}

/**
 * phase2/everywhere: one answer per question. The first press holds every answer on the card until
 * the reply comes back, so a quick second tap (easy with a thumb on a phone's big buttons) sends
 * nothing more; if the answer could not be sent, the buttons come back so it can be tried again.
 */
async function answerOnce(card, send) {
  if (card.dataset.answering) return;
  card.dataset.answering = "1";
  const buttons = [...card.querySelectorAll("button")];
  for (const one of buttons) one.disabled = true;
  try { await send(); }
  catch (error) {
    delete card.dataset.answering;
    for (const one of buttons) one.disabled = false;
    status(error.message);
  }
}
/** The question a paused task stopped on, answered without leaving the conversation. */
function askCard(question) {
  const card = el("div", undefined, "live-ask");
  card.id = "live-ask";
  card.append(el("strong", t("live.askTitle")), el("p", question.question));
  const listed = filesBlock(question, "meta");
  if (listed) card.append(listed);
  /* mac7/coding-next: "Let Branch run this project's tests?" has answers of its own. */
  const answers = question.kind === "project-tests" ? [
    [t("live.testsAlways"), "allow", "always"], [t("live.testsOnce"), "allow", "never"], [t("live.no"), "deny", "session"],
  ] : [
    [t("live.yesOnce"), "allow", "never"], [t("live.yesSession"), "allow", "session"],
    [t("live.yesAlways"), "allow", "always"], [t("live.no"), "deny", "session"],
  ];
  // Wave mac3 (tool-safety): a step the safety check advised against can only be allowed this once.
  if (question.onceOnly) card.append(el("p", t("live.onceOnly"), "meta"));
  for (const [label, decision, remember] of answers) {
    if (remember === "always" && question.source !== "owner") continue;
    if (remember === "always" && question.noStanding) continue; // Q59: Ask first and Plan keep no standing yes
    if (remember === "always" && question.noAlways) continue;
    if (remember === "always" && document.documentElement.dataset.household === "on") continue; // Q182: the owner's to give
    if (question.onceOnly && decision === "allow" && remember !== "never") continue;
    const choice = el("div", undefined, "live-ask-choice");
    choice.append(button(label, decision === "deny" ? "danger" : "", () => answerOnce(card, async () => {
      /* The yes is tied to the exact bytes shown, so a changed request has to ask again. */
      await api("policy/approve", {
        sessionId: question.sessionId, decision, remember,
        ...(question.fingerprint ? { fingerprint: question.fingerprint } : {}), carryOn: true,
      });
      card.replaceChildren(el("p", decision === "allow" ? t("live.steered") : t("live.stopped"), "meta"));
    })));
    /* Wave 7: say what this answer leaves behind before it is pressed, in the same words the
       "What is allowed right now" list uses for the same thing. */
    if (decision === "allow") choice.append(el("small", grantSentence(remember), "live-ask-grant"));
    card.append(choice);
  }
  return card;
}
/** Draws the live row from one activity item plus whatever the socket last reported. */
function paint(item, since, tokens) {
  const box = $("live-row");
  const line = $("live-line");
  line.replaceChildren(
    el("strong", taskWords(item?.task) || item?.current || t("live.working")),
    el("span", [t("live.elapsed", { seconds: formatNumber(Math.round((Date.now() - since) / 1000)) }),
      tokens ? t("live.tokens", { tokens: formatNumber(tokens) }) : ""].filter(Boolean).join(" · "), "meta"),
  );
  box.hidden = false;
}

/** The socket that reports every step of one task as it happens, once its id is known. */
function follow(runId, since, seen) {
  try {
    const socket = new WebSocket(new URL(`/api/runs/${runId}/ws`, location.href).href.replace(/^http/, "ws"), ["bearer", token()]);
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      const data = payload.data ?? {};
      if (typeof data.inputTokens === "number") seen.tokens += data.inputTokens + (data.outputTokens ?? 0);
      paint({ current: labelOf(payload.kind, data) }, since, seen.tokens);
    });
    return socket;
  } catch { return null; }
}
/**
 * Follows the task this conversation is running until it ends. The id only exists once the task has
 * started, so the row appears first and attaches its socket and controls as soon as it knows which
 * task it is looking at. A conversation with no id yet is matched on the message you sent.
 */
export function watchRun(sessionId, prompt) {
  stopWatching();
  const since = Date.now(), seen = { tokens: 0 };
  let socket = null;
  $("live-row").dataset.runId = "";
  $("live-controls-slot").replaceChildren();
  $("live-ask-slot").replaceChildren();
  $("live-steer-box").hidden = true;
  status("");
  paint(null, since, 0);
  const timer = setInterval(async () => {
    try {
      const running = await api("activity");
      const mine = running.find((item) => (sessionId ? item.sessionId === sessionId : item.prompt === prompt)) ?? null;
      if (mine) {
        paint(mine, since, seen.tokens);
        watching.sessionId = mine.sessionId;
        if ($("live-row").dataset.runId !== mine.runId) {
          $("live-row").dataset.runId = mine.runId;
          $("live-controls-slot").replaceChildren(controls(mine.runId));
          /* Recents shows this conversation straight away, marked as working (public/shell.js). */
          document.dispatchEvent(new CustomEvent("branch-run-started", { detail: { sessionId: mine.sessionId, runId: mine.runId } }));
          socket = follow(mine.runId, since, seen);
        }
      }
      await showQuestion(watching?.sessionId ?? sessionId);
    } catch { /* the next tick tries again */ }
  }, 1000);
  watching = { timer, sessionId, get socket() { return socket; } };
}
/** Puts the question a task stopped on into the conversation, if there is one waiting. */
async function showQuestion(sessionId) {
  const slot = $("live-ask-slot");
  if (!sessionId || slot.firstChild) return false;
  const waiting = (await api("policy")).waiting.filter((question) => question.sessionId === sessionId);
  if (!waiting.length) return false;
  slot.replaceChildren(askCard(waiting.at(-1)));
  $("live-row").hidden = false;
  return true;
}
/** Plain words for the event kinds the socket reports. */
function labelOf(kind, data) {
  if (kind === "tool.started") return `Using ${String(data.name ?? "a tool")}`;
  if (kind === "tool.completed") return `Finished ${String(data.name ?? "a tool")}`;
  if (kind === "model.started") return "Thinking";
  /* mac7/coding-next: a model on this computer that has not said anything yet may be loading into memory. */
  if (kind === "model.loading") return t("live.localLoading");
  if (kind === "policy.ask") return "Waiting for your answer";
  return t("live.working");
}
/**
 * Stops following. A question the task stopped on stays on the screen — the task ends the moment it
 * asks, and taking the question away with it would leave you nothing to answer.
 */
export function stopWatching(session) {
  if (!watching) return;
  const sessionId = session ?? watching.sessionId;
  clearInterval(watching.timer);
  try { watching.socket?.close(); } catch { /* already gone */ }
  watching = null;
  $("live-controls-slot").replaceChildren();
  $("live-steer-box").hidden = true;
  $("live-line").replaceChildren();
  $("live-row").hidden = !$("live-ask-slot").firstChild;
  /* A task that stopped to ask ends the moment it asks, often before the next poll came round. */
  void showQuestion(sessionId).catch(() => {});
}
$("live-steer-send").addEventListener("click", async () => {
  const text = $("live-steer-text").value.trim();
  const runId = $("live-row").dataset.runId || "";
  if (!text || !runId) return;
  try {
    await api(`runs/${runId}/steer`, { text });
    $("live-steer-text").value = "";
    $("live-steer-box").hidden = true;
    status(t("live.steered"));
  } catch (error) { status(error.message); }
});
globalThis.branchLiveRun = { watch: watchRun, stop: stopWatching };
