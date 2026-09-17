/**
 * Wave mac2: goal mode on the page. "/goal <what should be true> [--max n]" in the message box (or
 * the Goal button, which only fills in "/goal " for you) keeps the conversation working in rounds
 * until it is judged done. A strip above the box shows the round, the score from 0 to 1, what is
 * still missing and how long it has worked, with Pause, Resume and Stop.
 *
 * Everything here is reached through the page's own requests; nothing is sent to the model from
 * this file except by starting the goal. The pure pieces are exported so they can be tested without
 * a browser.
 */
export const DEFAULT_ROUNDS = 6;
export const MAX_ROUNDS = 20;

/** The same reading as src/goal-mode.ts: null when the line is not a goal command. */
export function parseGoalLine(line) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(String(line ?? "").trim());
  if (!match) return null;
  let text = (match[1] ?? "").trim();
  let maxRounds = DEFAULT_ROUNDS;
  const limit = /(?:^|\s)--max(?:=|\s+)(\S+)\s*$/.exec(text);
  if (limit) {
    const wanted = Number(limit[1]);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_ROUNDS) return { error: `--max takes a whole number from 1 to ${MAX_ROUNDS}.` };
    maxRounds = wanted;
    text = text.slice(0, limit.index).trim();
  }
  if (!text) return { error: "Say what the goal is: /goal <what should be true when it is done> [--max rounds]" };
  return { objective: text, maxRounds };
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  return minutes ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

const HEADINGS = {
  working: "Working toward the goal", paused: "Goal paused", done: "Goal done",
  blocked: "Goal blocked", stopped: "Goal stopped", limit: "Goal out of rounds",
};
/** What the strip says and which buttons it offers, for one goal. */
export function stripModel(goal) {
  const score = goal.score === null || goal.score === undefined ? null : Math.max(0, Math.min(1, Number(goal.score)));
  const actions = goal.status === "working" ? ["pause", "stop"] : goal.status === "paused" ? ["resume", "stop"] : ["dismiss"];
  return {
    heading: HEADINGS[goal.status] || "Goal",
    objective: goal.objective,
    rounds: `Round ${goal.round} of ${goal.maxRounds}`,
    score,
    scoreText: score === null ? "Not scored yet" : `Score ${score.toFixed(2)} of 1`,
    missing: Array.isArray(goal.missing) ? goal.missing.slice(0, 8) : [],
    elapsed: `Worked for ${formatElapsed(goal.elapsedMs)}`,
    reason: goal.reason || "",
    actions,
  };
}

const LABELS = { pause: "Pause", resume: "Resume", stop: "Stop", dismiss: "Hide" };
const POLL_MS = 2000;

if (typeof document !== "undefined") void boot();

async function boot() {
  const app = await import("/app.js");
  if (!app.SLASH_COMMANDS.some(([name]) => name === "/goal"))
    app.SLASH_COMMANDS.push(["/goal", "Keep working until a goal is met: /goal <what should be true> [--max rounds]."]);
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const strip = el("div", undefined, "plan-card goal-strip");
  strip.id = "goal-strip";
  strip.hidden = true;
  strip.setAttribute("role", "status");
  $("composer-dock")?.prepend(strip);
  const starter = el("button", "Goal", "text-button");
  starter.type = "button";
  starter.id = "goal-start";
  starter.title = "Keep working until a goal is met. Fills in /goal for you; nothing is sent until you press Send.";
  starter.addEventListener("click", () => {
    const box = $("prompt");
    if (!box.value.trim().startsWith("/goal")) box.value = "/goal " + box.value.trim();
    box.focus();
  });
  $("send")?.before(starter);

  let hiddenFor = "", lastSeen = "";
  const render = (goal, sessionId) => {
    if (!goal || hiddenFor === `${sessionId}:${goal.startedAt}`) { strip.hidden = true; return; }
    const model = stripModel(goal);
    const meter = el("progress");
    meter.max = 1;
    if (model.score !== null) meter.value = model.score;
    meter.setAttribute("aria-label", model.scoreText);
    const row = el("p", undefined, "meta");
    row.append(`${model.rounds} · ${model.scoreText} · ${model.elapsed}`);
    strip.replaceChildren(el("h3", model.heading), el("p", model.objective), meter, row);
    if (model.reason) strip.append(el("p", model.reason, "meta"));
    if (model.missing.length) {
      const list = el("ul");
      for (const item of model.missing) list.append(el("li", item));
      strip.append(el("p", "Still missing:", "meta"), list);
    }
    const controls = el("div", undefined, "message-controls");
    for (const action of model.actions) {
      const press = el("button", LABELS[action], "text-button");
      press.type = "button";
      press.addEventListener("click", () => void act(action, sessionId, goal));
      controls.append(press);
    }
    strip.append(controls);
    strip.hidden = false;
  };
  const act = async (action, sessionId, goal) => {
    if (action === "dismiss") { hiddenFor = `${sessionId}:${goal.startedAt}`; strip.hidden = true; return; }
    try { render((await app.api(`sessions/${sessionId}/goal`, { action })).goal, sessionId); }
    catch (error) { app.toast(error.message); }
  };
  const poll = async () => {
    const sessionId = globalThis.branchSessionId?.();
    if (!sessionId || document.visibilityState === "hidden") { if (!sessionId) strip.hidden = true; return; }
    try {
      const { goal } = await app.api(`sessions/${sessionId}/goal`);
      render(goal, sessionId);
      // A new round or a changed state means new messages: show them.
      const seen = goal ? `${sessionId}:${goal.round}:${goal.status}` : "";
      if (goal && seen !== lastSeen && lastSeen.startsWith(sessionId)) await app.openConversation(sessionId);
      lastSeen = seen || lastSeen;
    } catch { /* the next poll tries again */ }
  };
  setInterval(() => void poll(), POLL_MS);

  // Runs before the message box's own handler, so "/goal …" never reaches the model as a message.
  document.addEventListener("submit", (event) => {
    if (event.target?.id !== "chat-form") return;
    const parsed = parseGoalLine($("prompt").value);
    if (!parsed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (parsed.error) { app.toast(parsed.error); return; }
    void startGoal(parsed);
  }, true);
  const startGoal = async (parsed) => {
    const sessionId = globalThis.branchSessionId?.();
    try {
      const goal = await app.api("goals", { ...parsed, ...(sessionId ? { sessionId } : {}) });
      $("prompt").value = "";
      if (!sessionId) globalThis.branchAdoptSession?.(goal.sessionId);
      $("conversation").dataset.sessionId = goal.sessionId;
      lastSeen = `${goal.sessionId}:`;
      render(goal, goal.sessionId);
      await app.openConversation(goal.sessionId);
    } catch (error) { app.toast(error.message); }
  };
}
