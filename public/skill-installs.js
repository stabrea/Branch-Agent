/* Bucket 12: "Install a skill, and what happened", in Customize › Skills.

   Installs a skill from an Agent Skills folder (a .zip other agents share) or a Branch package, and
   removes one, while Branch runs; each time, the steps it took are written down and kept, so the
   owner can read exactly what was opened, checked, left out and allowed, or why it stopped. A skill
   can also be saved as an Agent Skills folder for another agent. The switch ships off. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function text(tag, words, className) {
  const node = make(tag, className);
  node.textContent = words;
  return node;
}
function button(key, english, quiet, onClick) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function labelled(id, key, english, control) {
  control.id = id;
  const label = make("label", "", key, english);
  label.htmlFor = id;
  return [label, control];
}
const POSITIONS = [["off", "field.switch-off", "Off"], ["when-needed", "field.switch-when-needed", "When needed"], ["on", "field.switch-on", "On"]];
const report = (words) => { const node = $("skill-installs-status"); if (node) node.textContent = words; };

async function fileBody() {
  const file = $("skill-installs-file")?.files?.[0];
  if (!file) throw new Error(say("skillInstalls.chooseFirst", "Choose a file first."));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { kind: /\.branchskill$/i.test(file.name) ? "package" : "agent-skill", file: btoa(binary) };
}
async function look() {
  try {
    const body = await fileBody();
    const preview = body.kind === "agent-skill"
      ? await api("skill-installs/inspect", { file: body.file })
      : await api("skills/package/inspect", { file: body.file });
    const left = preview.folder?.leftOut ?? [];
    report([`${preview.manifest.name}: ${preview.permissions.map((entry) => entry.why).join("; ")}.`,
      ...left.map((item) => `${item.path} — ${item.why}.`)].join("\n"));
  } catch (error) { report(error.message); }
}
async function install() {
  try {
    const answer = await api("skill-installs/install", { ...(await fileBody()), approve: true });
    report(answer.record.ok ? say("skillInstalls.installed", "Installed, switched off until you turn it on.") : answer.record.error);
    await draw();
  } catch (error) { report(error.message); }
}
async function remove() {
  const id = $("skill-installs-skill")?.value;
  if (!id) return;
  try {
    const answer = await api("skill-installs/remove", { skillId: id });
    report(answer.record.ok ? say("skillInstalls.removed", "Removed.") : answer.record.error);
    await draw();
  } catch (error) { report(error.message); }
}
async function saveFolder() {
  const id = $("skill-installs-skill")?.value;
  if (!id) return;
  try {
    const { filename, base64 } = await api(`skill-installs/export?skill=${encodeURIComponent(id)}`);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { report(error.message); }
}

function records(list) {
  const box = make("div", "skill-installs-records");
  if (!list.length) { box.append(make("p", "empty-state", "skillInstalls.none", "Nothing installed or removed from here yet. Each time you do, the steps are written down here.")); return box; }
  for (const record of list) {
    const details = make("details");
    const mark = record.ok ? say("skillInstalls.ok", "done") : say("skillInstalls.failed", "stopped");
    const verb = record.action === "remove" ? say("skillInstalls.removal", "Removal") : say("skillInstalls.install", "Install");
    details.append(text("summary", `${verb} · ${record.name || "?"} · ${mark} · ${new Date(record.at).toLocaleString()}`));
    const steps = make("ol");
    steps.append(...record.steps.map((step) => text("li", step)));
    details.append(steps);
    box.append(details);
  }
  return box;
}
function switchRow(mode) {
  const select = segmented({
    id: "skill-installs-mode",
    options: POSITIONS,
    value: mode,
    onChange: async (value) => {
      try { await api("skill-installs/settings", { mode: value }); await draw(); } catch (error) { report(error.message); }
    }
  });
  return [...labelled("skill-installs-mode", "skillInstalls.field.switch", "Install record", select),
    make("p", "field-note", "skillInstalls.note.switch", "Off: this card shows only this switch. On, or only when it is needed: install and remove here, and keep the steps each time.")];
}
function controls(view) {
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".zip,.branchskill";
  const skillOptions = view.skills.map((entry) => [entry.id, "", entry.name]);
  const skill = dropdown({
    id: "skill-installs-skill",
    options: skillOptions.length > 0 ? skillOptions : [["", "", "No skills"]],
    value: skillOptions.length > 0 ? skillOptions[0][0] : ""
  });
  return [...labelled("skill-installs-file", "skillInstalls.field.file", "An Agent Skills folder (.zip) or a Branch package", file),
    button("skillInstalls.action.look", "Look inside", true, look),
    button("skillInstalls.action.install", "Install it", false, install),
    make("p", "subtle", "skillInstalls.note.scripts", "A skill arrives switched off. Programs in its scripts folder are never run, and its other files are named, not unpacked."),
    ...labelled("skill-installs-skill", "skillInstalls.field.skill", "An installed skill", skill),
    button("skillInstalls.action.export", "Save as an Agent Skills folder", true, saveFolder),
    button("skillInstalls.action.remove", "Remove it", true, remove),
    make("p", "field-note", "skillInstalls.records", "What happened"), records(view.records)];
}
function buildCard(view) {
  const card = make("section", "card");
  card.id = "skill-installs-card";
  card.dataset.home = "settings:skills";
  card.append(make("h2", "", "skillInstalls.card.title", "Install a skill, and what happened"),
    make("p", "", "skillInstalls.card.purpose", "Add or remove a skill while Branch runs, including skills made for other agents, and read every step it took."),
    ...switchRow(view.mode));
  if (view.mode !== "off") card.append(...controls(view));
  const said = make("p", "subtle");
  said.id = "skill-installs-status";
  said.setAttribute("role", "status");
  said.style.whiteSpace = "pre-line";
  card.append(said);
  return card;
}
async function draw() {
  let view;
  try { view = await api("skill-installs"); } catch { return; }
  $("skill-installs-card")?.remove();
  document.body.append(buildCard(view));
}
function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}
if (typeof document !== "undefined") {
  document.addEventListener("branch-language", () => { draw().catch(() => {}); });
  whenReady(() => { draw().catch(() => {}); });
}
