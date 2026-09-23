/* Q64: a team's room shows the team's recent tasks: each task's state in Q51's words (public/task-state.js),
   who asked and who holds it, each member's role, run state and batch, an open handoff, what stops it, and
   its answers. Everything comes from GET /api/teams/:id/tasks (src/team-task-view.ts), which is the owner's
   alone: for a household profile or a short-lived key the card is simply not drawn. It sits just above the
   conversation, never inside it, so redrawing the conversation leaves it alone. Only looks; changes nothing. */
import { api, ownerAtWindow } from "/app.js";
import { formatDate, t } from "/i18n.js";
import { stateWords } from "/task-state.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (w, n) => (values && n in values ? String(values[n]) : w)) : word;
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Who asked, holds or is offered a task, in words. */
function who(party) {
  if (!party) return say("teamTasks.who.unknown", "someone unknown");
  if (party.kind === "window") return say("teamTasks.who.window", "you, in the app window");
  if (party.kind === "branch") return say("teamTasks.who.branch", "Branch, on this computer");
  if (party.kind === "key") return say("teamTasks.who.key", "a short-lived key");
  if (party.name) return party.name;
  return party.kind === "unknown" ? say("teamTasks.who.unknown", "someone unknown") : say("teamTasks.who.gone", "someone no longer here");
}

/** One member row: its role, its run's state in Q51's words, its batch, and a reviewer's place in the order. */
function memberRow(member) {
  const state = member.task ? stateWords(member.task)
    : member.status === "started" ? say("teamTasks.member.started", "started; its run was not recorded")
      : say("teamTasks.member.not-started", "not started");
  const parts = [state];
  if (member.batch) parts.push(say("teamTasks.batch", "batch {n}", { n: member.batch }));
  /* A reviewer's place in the order, only as the batches the turn really started say (src/team-task-view.ts). */
  if (member.after?.length) parts.push(say("teamTasks.after",
    "answers after {roles}, once their batch has finished; it is not given their answers", { roles: member.after.join(", ") }));
  else if (member.alongside?.length) parts.push(say("teamTasks.alongside",
    "runs alongside {roles} and does not wait for them", { roles: member.alongside.join(", ") }));
  const row = el("small", "team-task-member", `${member.role ?? say("teamTasks.member.unnamed", "a member not in the plan")}: ${parts.join(" · ")}`);
  row.dataset.member = member.member ?? "";
  return row;
}

/** The answers of a finished task, or that they were too large to keep, or deleted. */
function resultRows(result) {
  if (!result) return [];
  if (result.deleted) return [el("p", "team-task-note", say("teamTasks.deleted", "The answers are gone: a conversation they were in was deleted."))];
  if (result.truncated) return [el("p", "team-task-note", say("teamTasks.truncated", "The answers were too large to keep here. Every answer is in this room."))];
  return (result.answers ?? []).map((answer) => {
    const text = answer.output + (answer.cut ? ` ${say("teamTasks.cut", "(shortened)")}` : "");
    return el("p", "team-task-answer", `[${answer.role}] ${text}`);
  });
}

/** One task: its state word, who asked and holds it, a handoff or blocker line, its members and its answers. */
function taskCard(view) {
  const card = el("article", "rooms-artifact team-task");
  card.dataset.teamTask = view.taskId;
  card.dataset.taskState = view.task.state;
  card.append(el("b", "team-task-state", stateWords(view.task)));
  const whoLine = [say("teamTasks.asked-by", "Asked by {who}", { who: who(view.askedBy) }), formatDate(view.createdAt)];
  if (view.heldBy) whoLine.push(say("teamTasks.held-by", "held by {who}", { who: who(view.heldBy) }));
  card.append(el("small", "team-task-who", whoLine.join(" · ")));
  if (view.handoff) card.append(el("p", "team-task-handoff", say("teamTasks.handoff", "Offered to {who} since {time}: {reason}",
    { who: who(view.handoff.to), time: formatDate(view.handoff.since), reason: view.handoff.reason })));
  if (view.blocker) card.append(el("p", "team-task-blocker", view.task.state === "waiting-owner"
    ? say("teamTasks.question", "It asked: {text}", { text: view.blocker }) : say("teamTasks.why", "Why: {text}", { text: view.blocker })));
  card.append(...view.members.map(memberRow), ...resultRows(view.result));
  return card;
}

let teams = null; // GET /api/teams, read once a conversation shows and again after a task finishes
let drawing = 0;

/** The card for the team whose room is on screen, or none. */
async function draw({ fresh = false } = {}) {
  const turn = ++drawing;
  const here = $("conversation")?.dataset.sessionId || null;
  const ready = $("workspace")?.hidden === false && ownerAtWindow() && here;
  if (ready && (fresh || !teams)) teams = await api("teams").then((answer) => answer.teams).catch(() => null);
  const team = ready ? teams?.find((one) => one.roomSessionId === here) : null;
  const views = team ? await api(`teams/${team.id}/tasks`).then((answer) => answer.tasks).catch(() => null) : null;
  if (turn !== drawing) return;
  let box = $("team-tasks");
  if (!views?.length) { if (box) box.hidden = true; return; }
  if (!box) {
    box = el("section", "rooms-artifacts team-tasks");
    box.id = "team-tasks";
    $("conversation").before(box);
  }
  box.dataset.team = team.id;
  box.replaceChildren(el("h3", "", say("teamTasks.title", "This team's recent tasks")), ...views.map(taskCard));
  box.hidden = false;
}

function watch() {
  const box = $("conversation");
  if (!box) return;
  new MutationObserver(() => void draw()).observe(box, { attributes: true, attributeFilter: ["data-session-id"] });
  const workspace = $("workspace");
  if (workspace) new MutationObserver(() => void draw({ fresh: true })).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("branch-run-finished", () => void draw({ fresh: true }));
  document.addEventListener("branch-profile", () => void draw({ fresh: true }));
  document.addEventListener("branch-language", () => void draw());
}
globalThis.branchTeamTasks = { refresh: () => draw({ fresh: true }) };
watch();
void draw();
