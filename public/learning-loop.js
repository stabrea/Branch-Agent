/**
 * mac3/reflection-skills: two cards, each in the home docs/places.md gives it.
 *
 * - Library → Memory: "Looking back over conversations". The switch, how often, a button to look
 *   now, and each look's batch of suggestions with one yes or no for the lot. The single
 *   suggestions also wait in the Inbox, as every suggested memory change does.
 * - Customize → Skills: "Skills your assistant wrote". The switch, making a skill from a
 *   conversation, looking for unused skills, and each new skill with its trial and a yes or no.
 *
 * Both switches ship off. Nothing here writes a fact or switches a skill on without a press.
 * This file never touches the layout; each card declares its home and layout.js moves it there.
 */
import { t, formatDate } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/** A node whose words come from a key, so switching the language redraws it. */
const said = (tag, key, english, className) => {
  const node = el(tag, english, className);
  node.dataset.t = key;
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

const positions = [
  ["off", "field.switch-off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "field.switch-on", "On"],
];
function field(card, { id, key, words, control }) {
  const label = said("label", key, words);
  label.htmlFor = id;
  control.id = id;
  card.append(label, control);
  return control;
}
function switchControl(value) {
  const select = el("select");
  for (const [option, key, words] of positions) {
    const node = said("option", key, words);
    node.value = option;
    node.selected = option === value;
    select.append(node);
  }
  return select;
}
function numberControl(value, min, max) {
  const input = el("input");
  Object.assign(input, { type: "number", min: String(min), max: String(max), step: "1", value: String(value) });
  return input;
}
function quiet(key, words, onClick) {
  const button = said("button", key, words, "quiet-button");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await onClick(); } finally { button.disabled = false; }
  });
  return button;
}
/* What each card last said, so the answer to a press survives the card being drawn again. */
const lastSaid = new Map();
function statusLine(cardId) {
  const status = el("p", lastSaid.get(cardId) ?? "", "meta");
  status.setAttribute("role", "status");
  status.dataset.card = cardId;
  return status;
}
/** Runs one action, keeps what came of it for the card's status line, then redraws. */
const act = (status, work) => async () => {
  let words;
  try { words = await work(); } catch (error) { words = error.message; }
  lastSaid.set(status.dataset.card, words);
  status.textContent = words;
  await drawLearningLoop();
};
function card(id, home, title, purpose) {
  document.getElementById(id)?.remove();
  const node = el("section", undefined, "card");
  node.id = id;
  node.dataset.home = home;
  node.append(said("h2", ...title), said("p", ...purpose));
  return node;
}
function empty(what, next) {
  const box = el("div", undefined, "empty-state");
  box.append(said("p", ...what), said("p", ...next, "subtle"));
  return box;
}
function working(state) {
  const lines = [];
  if (state.working) lines.push(el("p", t("learning.note.working", { count: state.working }), "field-note"));
  const problem = (state.jobs ?? []).find((job) => !job.ok);
  if (problem) lines.push(el("p", t("learning.note.last-problem", { when: formatDate(problem.at), what: problem.detail }), "field-note"));
  return lines;
}

/* ── Library → Memory: looking back ── */

const kindWords = {
  put: ["learning.kind.remember", "Remember:"],
  update: ["learning.kind.correct", "Correct a note to:"],
  delete: ["learning.kind.forget", "Forget a note"],
  merge: ["learning.kind.merge", "Merge notes into:"],
  archive: ["learning.kind.set-aside", "Set notes aside"],
  forget: ["learning.kind.set-aside", "Set notes aside"],
  "skill-note": ["learning.kind.skill", "Change a skill:"],
};
const triggerWords = {
  turns: ["learning.trigger.turns", "after your last few turns"],
  compaction: ["learning.trigger.compaction", "when the conversation was shortened"],
  asked: ["learning.trigger.asked", "because you asked"],
};
function proposalLine(proposal) {
  const [key, words] = kindWords[proposal.kind] ?? kindWords.put;
  const line = el("li");
  line.append(said("strong", key, words), el("span", proposal.text ? ` ${proposal.text}` : ""));
  if (proposal.status !== "pending") line.append(el("span", ` · ${t(`learning.status.${proposal.status}`)}`, "meta"));
  return line;
}
function batchRecord(batch, status) {
  const node = el("div", undefined, "record");
  const [key] = triggerWords[batch.trigger] ?? triggerWords.asked;
  node.append(el("strong", t("learning.batch.title", { from: batch.fromMessage, to: batch.toMessage, when: formatDate(batch.createdAt) })));
  node.append(el("p", `${t(key)} · ${t("learning.batch.count", { count: batch.proposals.length })}`, "meta"));
  const list = el("ul");
  for (const proposal of batch.proposals) list.append(proposalLine(proposal));
  node.append(list);
  if (!batch.proposals.some((proposal) => proposal.status === "pending")) return node;
  const row = el("div", undefined, "skill-actions");
  const decide = (verdict) => act(status, async () => {
    const answer = await api(`reflection/batches/${batch.id}/${verdict}`, {});
    return answer.problems.length ? answer.problems.join(" ") : t("learning.note.decided", { count: answer.decided });
  });
  row.append(quiet("action.accept-all-waiting", "Accept all that are waiting", decide("accept")),
    quiet("action.turn-all-down", "Turn them all down", decide("reject")));
  node.append(row);
  return node;
}
function lookBackCard(state) {
  const node = card("learning-look-back", "settings:memory",
    ["library.card.looking-back", "Looking back over conversations"],
    ["library.note.looking-back", "Every so often your assistant rereads the latest turns of a conversation and suggests what to correct, merge or set aside in what it remembers, and how a skill could be better. Nothing changes until you say yes."]);
  const mode = field(node, { id: "look-back-switch", key: "field.looking-back", words: "Looking back", control: switchControl(state.settings.reflection) });
  node.append(said("p", "library.note.looking-back-positions", "On: after every few of your turns, and whenever a long conversation is shortened. When needed: only when a long conversation is shortened, or when you ask.", "field-note"));
  const turns = field(node, { id: "look-back-turns", key: "field.turns-between-looks", words: "Your turns between two looks", control: numberControl(state.settings.everyTurns, 5, 500) });
  node.append(said("p", "library.note.looking-back-cost", "Each look is one question to your model, counted against the conversation it reads. A temporary conversation is never read.", "subtle"));
  const status = statusLine("learning-look-back");
  const save = said("button", "action.save", "Save");
  save.type = "button";
  save.addEventListener("click", act(status, async () => {
    await api("reflection/settings", { reflection: mode.value, everyTurns: Number(turns.value) });
    return t("learning.note.saved");
  }));
  const now = quiet("action.look-back-now", "Look back at my latest conversation now", act(status, async () => {
    const { batch } = await api("reflection/look-back", {});
    return batch ? t("learning.batch.count", { count: batch.proposalIds.length }) : t("learning.note.nothing-new");
  }));
  node.append(save, now, status, ...working(state));
  const list = el("div", undefined, "card-list");
  list.id = "look-back-list";
  if (!state.batches.length) list.append(empty(["library.empty.no-looks", "No looks back yet."],
    ["library.empty.no-looks-next", "Turn looking back on above, or press Look back now. Its suggestions appear here and in your Inbox."]));
  for (const batch of state.batches.slice(0, 10)) list.append(batchRecord(batch, status));
  node.append(list);
  return node;
}

/* ── Customize → Skills: skills it wrote ── */

const SKIP_WORDS = "I have not tried this skill and I want it anyway";
function trialLine(draft) {
  if (!draft.trial) return draft.trialProblem ? t("learning.trial.problem", { what: draft.trialProblem }) : t("learning.trial.not-yet");
  return t(draft.trial.noWorse ? "learning.trial.no-worse" : "learning.trial.worse",
    { with: draft.trial.candidate.finished, without: draft.trial.baseline.finished, tasks: draft.trial.tasks });
}
function skipTrial(draft, status) {
  const box = el("div", undefined, "skill-actions");
  const open = said("button", "action.keep-without-trying", "Keep it without trying it", "quiet-button");
  open.type = "button";
  open.addEventListener("click", () => {
    const back = said("button", "action.leave-it-alone", "Leave it alone", "quiet-button");
    back.type = "button";
    back.addEventListener("click", () => box.replaceChildren(open));
    box.replaceChildren(said("p", "skills.note.skip-trial", "Trying a new skill is how you find out it does not make tasks go worse. Keeping it without that means nobody has checked.", "field-note"),
      quiet("action.keep-it-anyway", "Yes, keep it anyway", act(status, async () => {
        await api("reflection/new-skills/accept", { skillId: draft.skillId, force: true, confirm: SKIP_WORDS });
        return t("learning.note.kept", { name: draft.name });
      })), back);
  });
  box.append(open);
  return box;
}
function draftRecord(draft, status) {
  const node = el("div", undefined, "record");
  node.append(el("strong", `${draft.name} — ${draft.description}`), el("p", trialLine(draft), "meta"));
  const whole = el("details");
  whole.append(said("summary", "skills.label.the-whole-skill", "The whole skill"), el("pre", draft.diff, "code-input"));
  node.append(whole);
  if (draft.decision) { node.append(said("p", `learning.decision.${draft.decision}`, draft.decision, "meta")); return node; }
  const body = { skillId: draft.skillId };
  const row = el("div", undefined, "skill-actions");
  row.append(
    quiet("action.try-on-past-tasks", "Try it on past tasks", act(status, async () => trialLine({ trial: await api("reflection/new-skills/try", body) }))),
    quiet("action.keep-it", "Keep it", act(status, async () => { await api("reflection/new-skills/accept", body); return t("learning.note.kept", { name: draft.name }); })),
    quiet("action.throw-it-away", "Throw it away", act(status, async () => { await api("reflection/new-skills/reject", body); return t("learning.note.thrown", { name: draft.name }); })));
  node.append(row);
  if (!draft.trial || !draft.trial.noWorse) node.append(skipTrial(draft, status));
  return node;
}
function conversationPicker(sessions) {
  const select = el("select");
  if (!sessions.length) select.append(said("option", "field.no-conversations-yet", "No conversations yet"));
  for (const session of sessions) {
    const option = el("option", `${formatDate(session.createdAt, { dateStyle: "medium" })} — ${session.opening.slice(0, 60) || "…"}`);
    option.value = session.sessionId;
    select.append(option);
  }
  return select;
}
function learnControls(node, sessions, status) {
  const picker = field(node, { id: "learn-session", key: "field.a-conversation", words: "A conversation to make into a skill", control: conversationPicker(sessions) });
  const notes = field(node, { id: "learn-notes", key: "field.anything-to-add", words: "Anything to add (you can leave this empty)", control: el("textarea") });
  notes.rows = 2;
  notes.maxLength = 2000;
  node.append(quiet("action.draft-a-skill", "Draft a skill from it", act(status, async () => {
    if (!picker.value) throw new Error(t("field.no-conversations-yet"));
    await api("reflection/learn", { sessionId: picker.value, notes: notes.value });
    return t("learning.note.drafting");
  })));
}
function newSkillsCard(state, sessions) {
  const node = card("learning-new-skills", "settings:skills",
    ["skills.card.skills-your-assistant-wrote", "Skills your assistant wrote"],
    ["skills.note.skills-your-assistant-wrote", "Your assistant can write a new skill from something that went well. Each one arrives switched off, is tried on past tasks with and without it, and waits here for your yes."]);
  const mode = field(node, { id: "new-skills-switch", key: "field.writing-new-skills", words: "Writing new skills", control: switchControl(state.settings.newSkills) });
  node.append(said("p", "skills.note.writing-positions", "When needed: only when you ask, by typing /learn in a conversation or with the box below. On: also after a task that looked like steps worth keeping.", "field-note"));
  const days = field(node, { id: "retire-days", key: "field.unused-days", words: "Offer to set aside a skill unused for this many days", control: numberControl(state.settings.retireAfterDays, 7, 365) });
  const status = statusLine("learning-new-skills");
  const save = said("button", "action.save", "Save");
  save.type = "button";
  save.addEventListener("click", act(status, async () => {
    await api("reflection/settings", { newSkills: mode.value, retireAfterDays: Number(days.value) });
    return t("learning.note.saved");
  }));
  node.append(save);
  learnControls(node, sessions, status);
  node.append(quiet("action.look-for-unused-skills", "Look for skills nobody uses", act(status, async () => {
    const report = await api("reflection/retire", {});
    return report.offered.length ? t("learning.note.offered", { count: report.offered.length }) : report.reason;
  })), status, ...working(state));
  const list = el("div", undefined, "card-list");
  list.id = "new-skills-list";
  if (!state.newSkills.length) list.append(empty(["skills.empty.none-written", "No skills written yet."],
    ["skills.empty.none-written-next", "Switch writing new skills on, then ask for one from a conversation."]));
  for (const draft of state.newSkills.slice(0, 20)) list.append(draftRecord(draft, status));
  node.append(list);
  return node;
}

/** Draws both cards and lets layout.js put each where docs/places.md says it belongs. */
export async function drawLearningLoop() {
  let state, sessions;
  try {
    [state, { sessions }] = await Promise.all([api("reflection"), api("sessions?limit=20")]);
  } catch { return; }
  document.body.append(lookBackCard(state), newSkillsCard(state, sessions ?? []));
  // While something is being written or tried, look again shortly so it appears when it is ready.
  if (state.working && !followUp) followUp = setTimeout(() => { followUp = null; drawLearningLoop().catch(() => {}); }, 1500);
}
let followUp = null;

/* Drawn once the owner is signed in, and again each time the workspace is shown. The workspace
   appears a moment before the sign-in is stored, so the drawing waits for it rather than asking
   without it: a refused request counts towards the limit on failed sign-ins. */
const signedIn = () => { try { return !!sessionStorage.getItem("branch-token"); } catch { return false; } };
function whenSignedIn(draw, tries = 40) {
  if (signedIn()) { draw(); return; }
  if (tries > 0) setTimeout(() => whenSignedIn(draw, tries - 1), 250);
}
if (typeof document !== "undefined") {
  const redraw = () => { drawLearningLoop().catch(() => {}); };
  document.addEventListener("branch-language", () => { if (signedIn()) redraw(); });
  const workspace = document.getElementById("workspace");
  if (workspace) new MutationObserver(() => { if (!workspace.hidden) whenSignedIn(redraw); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
  if (signedIn()) redraw();
}
