/**
 * Wave mac2: goal mode on the page. "/goal <what should be true> [--max n]" in the message box (or
 * the Goal button beside the conversation's plan, which only fills in "/goal " for you) keeps the
 * conversation working in rounds until it is judged done. A strip with the plan shows the round, the score from 0 to 1, what is
 * still missing and how long it has worked, with Pause, Resume and Stop. Every word on screen comes
 * from public/locales through `t`.
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
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_ROUNDS) return { error: "goal.errorMax", values: { max: MAX_ROUNDS } };
    maxRounds = wanted;
    text = text.slice(0, limit.index).trim();
  }
  if (!text) return { error: "goal.errorEmpty", values: {} };
  return { objective: text, maxRounds };
}

/** How long it has worked, in the words `t` gives. */
export function formatElapsed(ms, t) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const pad = (value) => String(value).padStart(2, "0");
  if (minutes >= 60) return t("goal.timeHours", { h: Math.floor(minutes / 60), m: pad(minutes % 60) });
  return minutes ? t("goal.timeMinutes", { m: minutes, s: pad(seconds % 60) }) : t("goal.timeSeconds", { s: seconds });
}

const HEADINGS = new Set(["working", "paused", "done", "blocked", "stopped", "limit"]);
/** What the strip says and which buttons it offers, for one goal, in the words `t` gives. */
export function stripModel(goal, t) {
  const score = goal.score === null || goal.score === undefined ? null : Math.max(0, Math.min(1, Number(goal.score)));
  const actions = goal.status === "working" ? ["pause", "stop"] : goal.status === "paused" ? ["resume", "stop"] : ["dismiss"];
  return {
    heading: t(HEADINGS.has(goal.status) ? `goal.heading.${goal.status}` : "goal.heading.other"),
    objective: goal.objective,
    rounds: t("goal.rounds", { round: goal.round, max: goal.maxRounds }),
    score,
    scoreText: score === null ? t("goal.notScored") : t("goal.score", { score: score.toFixed(2) }),
    missing: Array.isArray(goal.missing) ? goal.missing.slice(0, 8) : [],
    elapsed: t("goal.elapsed", { time: formatElapsed(goal.elapsedMs, t) }),
    reason: goal.reason || "",
    actions: actions.map((action) => ({ action, label: t(`goal.action.${action}`) })),
  };
}

export const MODES = ["off", "when-needed", "on"];
/** The Goal button is shown only when goal mode is switched fully on. */
export const showsGoalButton = (settings) => settings?.goal === "on";

const POLL_MS = 2000;

if (typeof document !== "undefined") void boot();

async function boot() {
  const app = await import("/app.js");
  const { t } = await import("/i18n.js");
  // The words may not be loaded yet when this runs; everything below is worded again once they are.
  const help = ["/goal", t("goal.commandHelp")];
  if (!app.SLASH_COMMANDS.some(([name]) => name === "/goal")) app.SLASH_COMMANDS.push(help);
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
  // The goal lives beside the conversation's plan ("Still to do"), which the redesigned window
  // shows in the pane's Plan tab; the message box keeps only what changes the next message.
  const planBlock = $("context-todos")?.closest(".context-block");
  const home = planBlock ?? $("composer-dock");
  home?.prepend(strip);
  const starter = el("button", t("goal.button"), "text-button");
  starter.type = "button";
  starter.id = "goal-start";
  starter.dataset.t = "goal.button";
  starter.dataset.tTitle = "goal.buttonTitle";
  starter.title = t("goal.buttonTitle");
  starter.addEventListener("click", () => {
    const box = $("prompt");
    if (!box.value.trim().startsWith("/goal")) box.value = "/goal " + box.value.trim();
    box.focus();
  });
  strip.after(starter);
  starter.hidden = true;
  const applySettings = (settings) => { starter.hidden = !showsGoalButton(settings); };
  app.api("goal-undo/settings").then(applySettings, () => undefined);
  settingsCard($, el, t, app, applySettings);

  let hiddenFor = "", lastSeen = "";
  const render = (goal, sessionId) => {
    if (!goal || hiddenFor === `${sessionId}:${goal.startedAt}`) { strip.hidden = true; return; }
    const model = stripModel(goal, t);
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
      strip.append(el("p", t("goal.missing"), "meta"), list);
    }
    const controls = el("div", undefined, "message-controls");
    for (const { action, label } of model.actions) {
      const press = el("button", label, "text-button");
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
  /**
   * Shows the new messages. Opening a conversation closes the side pane a narrow window floats over
   * it (public/layout.js), and the strip lives in that pane, so the tab that was open is pressed again.
   */
  const reopen = async (sessionId) => {
    const pressed = document.body.classList.contains("lx-pane-float") ? document.querySelector('.lx-pane-tab[aria-pressed="true"]') : null;
    await app.openConversation(sessionId);
    if (pressed && !document.body.classList.contains("lx-pane-float")) pressed.click();
  };
  const poll = async () => {
    const sessionId = globalThis.branchSessionId?.();
    if (!sessionId || document.visibilityState === "hidden") { if (!sessionId) strip.hidden = true; return; }
    try {
      const { goal } = await app.api(`sessions/${sessionId}/goal`);
      render(goal, sessionId);
      // A new round or a changed state means new messages: show them.
      const seen = goal ? `${sessionId}:${goal.round}:${goal.status}` : "";
      if (goal && seen !== lastSeen && lastSeen.startsWith(sessionId)) await reopen(sessionId);
      lastSeen = seen || lastSeen;
    } catch { /* the next poll tries again */ }
  };
  setInterval(() => void poll(), POLL_MS);
  document.addEventListener("branch-language", () => { help[1] = t("goal.commandHelp"); void poll(); });

  // Runs before the message box's own handler, so "/goal …" never reaches the model as a message.
  document.addEventListener("submit", (event) => {
    if (event.target?.id !== "chat-form") return;
    const parsed = parseGoalLine($("prompt").value);
    if (!parsed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (parsed.error) { app.toast(t(parsed.error, parsed.values)); return; }
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

/** The Settings card: the two switches for this area, each off, on or when needed. */
function settingsCard($, el, t, app, applied) {
  const worded = (tag, key, className) => { const node = el(tag, t(key), className); node.dataset.t = key; return node; };
  const form = el("form", undefined, "card");
  form.id = "goal-undo-form";
  const choice = (name, labelKey, hintKey) => {
    const label = el("label");
    const select = el("select");
    select.id = `goal-undo-${name}`;
    select.name = name;
    for (const mode of MODES) {
      const option = worded("option", `goalUndo.mode.${mode}`);
      option.value = mode;
      select.append(option);
    }
    label.append(worded("span", labelKey), select);
    return [label, worded("p", hintKey, "meta")];
  };
  const status = el("p", undefined, "meta");
  status.setAttribute("role", "status");
  form.append(worded("h2", "settings.card.goal-undo"), worded("p", "goalUndo.intro", "subtle"),
    ...choice("goal", "goalUndo.goalLabel", "goalUndo.goalHint"),
    ...choice("snapshots", "goalUndo.snapshotsLabel", "goalUndo.snapshotsHint"),
    worded("button", "goalUndo.save"), status);
  const show = (settings) => {
    form.elements.goal.value = settings.goal;
    form.elements.snapshots.value = settings.snapshots;
    applied(settings);
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      show(await app.api("goal-undo/settings", { goal: form.elements.goal.value, snapshots: form.elements.snapshots.value }));
      status.textContent = t("goalUndo.saved");
    } catch (error) { status.textContent = error.message; }
  });
  // Beside "Workspace snapshots", which the redesigned window keeps under Settings → data. The home
  // lets public/layout.js place it there even when this runs before that card has been moved.
  form.dataset.home = "settings:data";
  const after = $("snapshots-card");
  if (after) after.after(form); else $("settings")?.append(form);
  app.api("goal-undo/settings").then(show, () => undefined);
}
