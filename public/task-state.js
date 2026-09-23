/* Q51: what a task is really doing, in the owner's words, from the `task` field /api/activity gives each task
   (src/activity.ts `taskState`): working, waiting for you, waiting for a service or blocked, the reason the task's
   own events give, and when it last recorded anything. No percentage: nothing records how much is left. */
import { t } from "/i18n.js";

const say = (key, fallback, values) => { const words = t(key, values); return words === key ? fallback : words; };
const WORDS = {
  "waiting-owner": {
    "policy.ask": ["task.owner.ask", "Waiting for your answer"],
    "attention.needed": ["task.owner.ask", "Waiting for your answer"],
    "plan.awaiting_approval": ["task.owner.plan", "Waiting for your OK on its plan"],
    "folder.trust_needed": ["task.owner.folder", "Waiting for you to trust a folder"],
    "web.challenge": ["task.owner.web", "Waiting for you on a website"],
    "run.can_continue": ["task.owner.continue", "Stopped when Branch closed; waiting for you to continue"],
    interrupted: ["task.owner.continue", "Stopped when Branch closed; waiting for you to continue"],
    "": ["task.owner", "Waiting for you"],
  },
  "waiting-service": {
    "rate.paused": ["task.service.rate", "Paused by a limit on how often it may ask"],
    "model.retry_scheduled": ["task.service.retry", "Waiting to try the model again"],
    "model.loading": ["task.service.loading", "Waiting for the model to load"],
    "model.fallback": ["task.service.fallback", "Moved to another model while the first is busy"],
    "model.stalled": ["task.service.stalled", "The model went quiet"],
    "model.stall_recovery": ["task.service.stalled", "The model went quiet"],
    "context.compacting": ["task.service.compacting", "Summarising the conversation to make room"],
    "run.stuck": ["task.service.stuck", "Stuck; trying another way"],
    "": ["task.service", "Waiting for a service"],
  },
  blocked: {
    "policy.denied": ["task.blocked.policy", "Blocked by your settings"],
    "hook.blocked": ["task.blocked.hook", "Blocked by a check you set up"],
    "provider.refused": ["task.blocked.provider", "The model service refused"],
    "reconciliation.required": ["task.blocked.reconcile", "Blocked until a step's outcome is checked"],
    "rounds.exhausted": ["task.blocked.rounds", "Stopped at the most rounds allowed"],
    "": ["task.blocked", "Blocked"],
  },
  queued: {
    "run.queued": ["task.queued", "Waiting its turn"],
    "": ["task.queued", "Waiting its turn"],
  },
};

/** The state in words, with the task's own reason after it; null while it simply works. */
export function taskWords(task) {
  if (!task || task.state === "working" || task.state === "finished") return null;
  const table = WORDS[task.state] ?? {};
  const [key, fallback] = table[task.why] ?? table[""] ?? ["", ""];
  const words = say(key, fallback);
  // Q58: a queued task gives its place as a plain number, so every language reads it the same way ("position 2").
  if (task.state === "queued") {
    const position = task.position ?? 1;
    if (task.waitingBehind) return say("task.queued.behind", `${words} · position ${position}, behind "${task.waitingBehind}"`, { words, position, behind: task.waitingBehind });
    return words;
  }
  return task.reason ? say("task.with", `${words}: ${task.reason}`, { words, reason: task.reason }) : words;
}

const ago = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? say("task.ago.seconds", `${seconds} s ago`, { n: seconds }) : say("task.ago.minutes", `${Math.round(seconds / 60)} min ago`, { n: Math.round(seconds / 60) });
};
/** "Updated 12 s ago", or "No update for 4 min" when it has gone quiet, and when a wait ends if its event said. */
export function taskWhen(task, now = Date.now()) {
  if (!task?.lastUpdate) return "";
  const quiet = now - Date.parse(task.lastUpdate);
  const minutes = Math.max(1, Math.round(quiet / 60000));
  const parts = [task.stale ? say("task.stale", `No update for ${minutes} min`, { n: minutes }) : say("task.updated", `Updated ${ago(quiet)}`, { time: ago(quiet) })];
  if (task.until) {
    const left = Date.parse(task.until) - now;
    if (left > 0) parts.push(say("task.until", `until about ${new Date(task.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      { time: new Date(task.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  }
  return parts.join(" · ");
}
