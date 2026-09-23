/* DG-193: Settings › Trunks & people, as the approved sample draws it: three sections, Trunks, Edit Trunk and
   A person's card, each holding the real settings. Their homes stay where they are (Trunks in Customize ›
   Specialists, people in General); these cards are a second way in to the same settings, saved as you go
   through the same API, and each control names its setting in data-sg-mirror so its row levels and counts as the
   sample's (public/settings-rows.js). Placed through data-home (public/layout.js). */
import { api, displayView } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";
import { draw as drawTrunks } from "/trunks.js";

const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function worded(tag, key, english, className) {
  const node = document.createElement(tag);
  node.dataset.t = key;
  node.textContent = say(key, english);
  if (className) node.className = className;
  return node;
}
/** One row: the words, the control and nothing else, so the row levels by itself. */
function row(id, key, english, control) {
  const box = document.createElement("div");
  box.className = "settings-trunks-row";
  const label = worded("label", key, english);
  label.htmlFor = id;
  control.id = id;
  control.dataset.sgMirror = id.replace(/^settings-/, "");
  box.append(label, control);
  return box;
}
function card(id, mirrors) {
  const node = document.createElement("section");
  node.className = "card settings-trunks-card";
  node.id = id;
  node.dataset.home = "settings:trunks";
  node.dataset.sgMirrors = mirrors.join(" ");
  return node;
}
function status(node) {
  const line = document.createElement("p");
  line.className = "subtle settings-trunks-status";
  line.setAttribute("role", "status");
  node.append(line);
  return (error) => { delete line.dataset.t; line.textContent = error ? error.message ?? String(error) : say("trunks.saved", "Saved."); if (!error) line.dataset.t = "trunks.saved"; };
}
function openButton(key, english, route) {
  const open = worded("button", key, english, "quiet-button settings-trunks-open");
  open.type = "button";
  open.addEventListener("click", () => displayView(route));
  return open;
}
function place(node) {
  const old = document.getElementById(node.id);
  if (old) old.replaceWith(node); else document.body.append(node);
}

/* ---------- Trunks: the five switches ---------- */
const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "When needed"]];
const PARTS = [["trunks", "Trunks"], ["rooms", "Rooms where Trunks talk together"], ["messages", "Trunks messaging each other"],
  ["routines", "Routines a Trunk owns"], ["teach", "Teaching a Trunk by showing it once"]];
function switchesCard(modes) {
  const node = card("settings-trunks-switches", PARTS.map(([part]) => `trunks-switch-${part}`));
  const told = status(node);
  const rows = PARTS.map(([part, english]) => row(`settings-trunks-switch-${part}`, `trunks.part.${part}`, english, dropdown({
    options: POSITIONS, value: modes[part] ?? "off",
    onChange: async (mode) => { try { await api("trunks/switch", { part, mode }); told(); await drawTrunks(); await drawAll(); } catch (error) { told(error); } },
  })));
  node.prepend(...rows, openButton("settingsTrunks.open.trunks", "Open Trunks", "customize:specialists"));
  return node;
}

/* ---------- Edit Trunk: every field of one Trunk ---------- */
const TEXTS = [["name", "Name"], ["title", "What it does, in a few words"], ["description", "About it", true], ["model", "Model (empty: the conversation's, then your default)"]];
const LISTS = [["permissions", "permissions", "Tools it may use, by permission (empty: your usual set)"], ["skills", "skills", "Skills it reaches for first"],
  ["mcp", "mcpServers", "Connected tool servers it may use (none by default)"], ["channels", "channels", "Chat apps it answers on (none by default)"]];
const TICKS = [["commands", "trunks.field.commands", "May run commands on this computer"], ["hidden", "trunks.field.hidden", "Hide it from the sidebar"],
  ["pinned", "trunks.field.pinned", "Pin it to the top"], ["keys", "trunks.field.copyKeys", "Uses copies of your keys (sign-ins are never copied)"]];
const REASONING = [["", "trunks.reasoning.default", "The model's own"], ["low", "trunks.reasoning.low", "Low"], ["medium", "trunks.reasoning.medium", "Medium"], ["high", "trunks.reasoning.high", "High"]];
const STYLES = [["default", "trunks.style.default", "The ordinary way"], ["react", "trunks.style.react", "Thinks out loud"], ["plan-execute", "trunks.style.plan", "Plans first"],
  ["critic", "trunks.style.critic", "Reviews without changing anything"], ["researcher", "trunks.style.researcher", "Looks things up"], ["coder", "trunks.style.coder", "Writes code"]];
const split = (text) => text.split(",").map((part) => part.trim()).filter(Boolean);
/** What the Trunk's editor saves, from the Trunk as it is. */
function valuesOf(trunk) {
  return { name: trunk.name, title: trunk.title, description: trunk.description, model: trunk.model ?? "", reasoning: trunk.reasoning ?? null,
    instructions: trunk.instructions, style: trunk.style, permissions: trunk.permissions, skills: trunk.skills, mcpServers: trunk.mcpServers,
    section: trunk.section, sharedFacts: trunk.sharedFacts, keys: trunk.keys, reach: trunk.reach, hidden: trunk.hidden, pinned: trunk.pinned };
}
function textControl(value, long) {
  const node = document.createElement(long ? "textarea" : "input");
  node.value = value ?? "";
  if (long) node.rows = 3;
  return node;
}
function tickControl(checked) {
  const node = document.createElement("input");
  node.type = "checkbox";
  node.checked = Boolean(checked);
  return node;
}
/** The rows of the editor, each saving its own field when it changes. */
function editRows(trunk, save) {
  const on = (control, event, change) => { control.addEventListener(event, () => save(change(control))); return control; };
  const texts = TEXTS.map(([name, english, long]) => row(`settings-trunk-edit-${name}`, `trunks.field.${name}`, english,
    on(textControl(trunk?.[name], long), "change", (c) => ({ [name]: c.value.trim() }))));
  const lists = LISTS.map(([name, field, english]) => row(`settings-trunk-edit-${name}`, `trunks.field.${name}`, english,
    on(textControl((field === "channels" ? trunk?.reach.channels : trunk?.[field])?.join(", ")), "change",
      (c) => (field === "channels" ? { reach: { ...trunk.reach, channels: split(c.value) } } : { [field]: split(c.value) }))));
  const ticks = TICKS.map(([name, key, english]) => row(`settings-trunk-edit-${name}`, key, english, on(tickControl(
    name === "commands" ? trunk?.reach.commands : name === "keys" ? trunk?.keys.copyFromOwner : trunk?.[name]), "change",
    (c) => (name === "commands" ? { reach: { ...trunk.reach, commands: c.checked } } : name === "keys" ? { keys: { ...trunk.keys, copyFromOwner: c.checked } } : { [name]: c.checked }))));
  const pick = (options, value, name) => on(dropdown({ options, value: value ?? "" }), "change", (c) => ({ [name]: c.value || (name === "reasoning" ? null : c.value) }));
  const [name, title, description, model] = texts;
  /* The sample's order: the switches, then the choices, then the words, then the lists. */
  return [...ticks, model,
    row("settings-trunk-edit-reasoning", "trunks.field.reasoning", "How hard it thinks", pick(REASONING, trunk?.reasoning, "reasoning")),
    row("settings-trunk-edit-style", "trunks.field.style", "How it works", pick(STYLES, trunk?.style ?? "default", "style")),
    pictureRow(), name, title, description,
    row("settings-trunk-edit-instructions", "trunks.field.instructions", "Its own instructions", on(textControl(trunk?.instructions, true), "change", (c) => ({ instructions: c.value }))),
    row("settings-trunk-edit-section", "trunks.field.section", "Sidebar section", on(textControl(trunk?.section), "change", (c) => ({ section: c.value.trim() }))),
    ...lists];
}
/** The picture is made, uploaded or kept in the Trunk's own editor. */
function pictureRow() {
  const open = worded("button", "settingsTrunks.picture.open", "Change it in Trunks", "quiet-button");
  open.type = "button";
  open.addEventListener("click", () => displayView("customize:specialists"));
  return row("settings-trunk-edit-picture", "settingsTrunks.picture", "A Trunk's picture", open);
}
const EDIT_IDS = ["commands", "hidden", "name", "title", "description", "model", "reasoning", "instructions", "style", "permissions", "skills", "mcp",
  "channels", "section", "pinned", "keys", "picture"].map((name) => `trunk-edit-${name}`);
let chosenTrunk = "";
function editCard(roster) {
  const node = card("settings-trunk-edit", EDIT_IDS);
  const told = status(node), trunks = roster.modes.trunks === "off" ? [] : roster.trunks;
  if (!trunks.some((trunk) => trunk.id === chosenTrunk)) chosenTrunk = trunks[0]?.id ?? "";
  const trunk = trunks.find((one) => one.id === chosenTrunk);
  const save = async (change) => {
    try { await api(`trunks/${trunk.id}`, { ...valuesOf(trunk), ...change }); told(); await drawTrunks(); await drawAll(); } catch (error) { told(error); }
  };
  const rows = editRows(trunk, save);
  const which = dropdown({ options: trunks.map((one) => [one.id, "", one.name]), value: chosenTrunk,
    onChange: (id) => { chosenTrunk = id; void drawAll(); } });
  node.prepend(trunk ? row("settings-trunk-pick", "settingsTrunks.pick", "Which Trunk", which) : worded("p", "settingsTrunks.none", "Make a Trunk first, in Trunks. Its settings are then here.", "field-note"), ...rows);
  if (!trunk) for (const control of node.querySelectorAll("input, textarea, select, button")) control.disabled = true;
  return node;
}

/* ---------- A person's card: what one person may do ---------- */
const ROLES = [["owner", "settingsTrunks.role.owner", "Owner"], ["adult", "settingsTrunks.role.adult", "Adult"], ["child", "settingsTrunks.role.child", "Child"]];
let chosenPerson = "";
function personRows(grant, save) {
  const role = dropdown({ options: ROLES, value: grant?.role ?? "adult" });
  role.addEventListener("change", () => save({ role: role.value }));
  const limit = document.createElement("input");
  limit.type = "number"; limit.min = "0"; limit.max = "1000"; limit.step = "0.5";
  limit.value = String(grant?.dailySpendLimit ?? 0);
  limit.addEventListener("change", () => save({ dailySpendLimit: Math.max(0, Number(limit.value) || 0) }));
  const projects = textControl(grant?.projects?.join(", "));
  projects.addEventListener("change", () => save({ projects: split(projects.value) }));
  return [row("settings-person-role", "settingsTrunks.role", "Make them", role),
    row("settings-person-daily-limit", "settingsTrunks.limit", "Up to this much a day (0: no limit)", limit),
    row("settings-person-projects", "settingsTrunks.projects", "Only in these projects (empty: every project)", projects)];
}
async function personCard(people) {
  const node = card("settings-person-card", ["person-role", "person-daily-limit", "person-projects"]);
  const told = status(node);
  if (!people.some((person) => person.id === chosenPerson)) chosenPerson = people[0]?.id ?? "";
  const grant = chosenPerson ? await api(`profiles/${chosenPerson}/role`).catch(() => null) : null;
  const save = async (change) => {
    try { await api(`profiles/${chosenPerson}/role`, change); told(); await drawAll(); } catch (error) { told(error); }
  };
  const which = dropdown({ options: people.map((one) => [one.id, "", one.name]), value: chosenPerson, onChange: (id) => { chosenPerson = id; void drawAll(); } });
  node.prepend(chosenPerson ? row("settings-person-pick", "settingsTrunks.person", "Whose card", which) : worded("p", "settingsTrunks.nobody", "Add someone in People first. What they may do is then here.", "field-note"),
    ...personRows(grant, save), openButton("settingsTrunks.open.people", "Open People", "household"));
  if (!chosenPerson) for (const control of node.querySelectorAll("input, select")) control.disabled = true;
  return node;
}

/* ---------- drawing ---------- */
export async function drawAll() {
  try {
    const [roster, profiles] = await Promise.all([api("trunks"), api("profiles")]);
    const edit = editCard(roster);
    place(switchesCard(roster.modes));
    place(edit);
    place(await personCard(profiles.profiles ?? []));
  } catch { /* the cards failing leave the rest of Settings as it was */ }
}
/* Drawn once the window is connected, as public/trunks.js is. */
function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && document.getElementById("workspace")?.hidden === false;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => { if (ready()) { watch.disconnect(); work(); } });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const workspace = document.getElementById("workspace");
  if (workspace) watch.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
}
whenReady(() => void drawAll());
