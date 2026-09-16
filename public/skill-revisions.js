/**
 * Better versions of a skill, written by the app after a task that went well. Nothing here changes
 * on its own: you see the lines that changed, you can try the new version against your last few
 * tasks as a practice run (where nothing is really done), and then you keep it or throw it away.
 */
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function trialLine(trial) {
  if (!trial) return "Not tried yet against your recent tasks.";
  const side = (name, s) => `${name}: ${s.finished} of ${trial.tasks} finished`;
  return `${trial.noWorse ? "Did at least as well" : "Did worse"} — ${side("the one in use", trial.baseline)}, ${side("the new one", trial.candidate)}.`;
}
function button(label, onClick) {
  const node = el("button", label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await onClick(); await draw(); } catch (error) { toast(error.message); node.disabled = false; }
  });
  return node;
}
function card(revision) {
  const node = el("div", undefined, "card");
  node.append(el("strong", `${revision.skillName} — suggested version ${revision.version}`));
  node.append(el("p", `${revision.added} line(s) added, ${revision.removed} taken away. ${trialLine(revision.trial)}`, "meta"));
  const changed = el("pre", revision.diff || "(no visible change)", "code-input");
  changed.style.maxHeight = "18rem";
  changed.style.overflow = "auto";
  node.append(changed);
  if (revision.decision) {
    node.append(el("p", revision.decision === "accepted" ? "You kept this one." : "You threw this one away.", "meta"));
    return node;
  }
  const actions = el("div", undefined, "skill-actions");
  const body = { skillId: revision.skillId, version: revision.version };
  actions.append(button("Try it on my last few tasks", () => api("skill-revisions/try", body)));
  actions.append(button("Keep it", () => api("skill-revisions/accept", body)));
  actions.append(button("Throw it away", () => api("skill-revisions/reject", body)));
  node.append(actions);
  return node;
}
async function draw() {
  const list = $("skill-revisions-list");
  if (!list) return;
  try {
    const { revisions } = await api("skill-revisions");
    list.replaceChildren();
    if (!revisions.length) { list.append(el("p", "No suggestions right now.", "meta")); return; }
    for (const revision of revisions) list.append(card(revision));
  } catch (error) { list.replaceChildren(el("p", error.message, "meta")); }
}

$("skill-revisions-refresh")?.addEventListener("click", () => { void draw(); });
