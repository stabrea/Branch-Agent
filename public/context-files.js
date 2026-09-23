/**
 * The switches for the files the owner writes by hand.
 *
 * There are eight of them — SOUL, IDENTITY, USER, AGENTS, TOOLS, SOP, MEMORY and HEARTBEAT — and
 * the tempting thing is to put all eight on one screen called "Context files". `docs/places.md`
 * says not to, and it is right: nobody goes looking for a screen named after the implementation.
 * They go to where the subject already lives. So the switch for the file about who the assistant
 * is sits with the rest of the assistant's identity, the one about standing procedures sits with
 * procedures, and so on. Six cards, each declaring its own home, each moved there by
 * `public/layout.js` — this file never touches the layout.
 *
 * Every card says the same three things, because the owner should not have to learn a new shape
 * six times: what the file is for, whether it was found and how big it is, and the one switch with
 * three positions. Everything ships off.
 */

import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
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

/** The cards, in the homes docs/places.md gives them. One card may carry more than one file. */
const cards = [
  {
    id: "context-assistant", home: "settings:assistant",
    title: ["settings.card.who-your-assistant-is", "Who your assistant is"],
    purpose: ["settings.note.persona-files",
      "Write these in plain words and your assistant reads them before it does anything else. What you put in the first one replaces its built-in character rather than being added to it."],
    files: ["soul", "identity", "user"],
    /* DG-181: a row of the page's one section, as in the sample: its title is read aloud under the section's
       heading (DG-008) and each switch is kept the moment it moves (DG-025). */
    inSection: true,
  },
  {
    id: "context-project", home: "settings:general",
    title: ["settings.card.how-to-work-here", "How to work in this project"],
    purpose: ["settings.note.agents-file",
      "A file in the project folder saying how you want work done here. Written after something goes the wrong way, it changes the next task rather than the one after you remember to mention it."],
    files: ["agents"],
  },
  {
    id: "context-memory-file", home: "library:memory",
    title: ["settings.card.memory-you-wrote-yourself", "Memory you wrote yourself"],
    purpose: ["settings.note.memory-file",
      "Everything else here your assistant remembered on its own. This is a file you write, so you can open it, read the whole thing and change your mind about any of it."],
    files: ["memory"],
  },
  {
    id: "context-heartbeat", home: "automations:scheduled",
    title: ["settings.card.what-to-check-when-it-wakes", "What to check when it wakes"],
    purpose: ["settings.note.heartbeat-file",
      "A list your assistant reads each time it wakes on a schedule. An empty file means there is nothing to do and it goes back to sleep without spending anything."],
    files: ["heartbeat"],
  },
  {
    id: "context-sop", home: "automations:procedures",
    title: ["settings.card.how-you-want-things-done", "How you want things done"],
    purpose: ["settings.note.sop-file",
      "Steps you want followed the same way every time, written as prose rather than built as a procedure."],
    files: ["sop"],
  },
  {
    id: "context-tools-file", home: "customize:skills",
    title: ["settings.card.your-notes-about-your-tools", "Your notes about your tools"],
    purpose: ["settings.note.tools-file",
      "What your assistant should know about the programs on this computer: which one to reach for, and the quirks it would otherwise find out the hard way."],
    files: ["tools"],
  },
];

const positions = [
  ["off", "field.switch-off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "field.switch-on", "On"],
];
const fileNames = {
  soul: ["field.file-soul", "Its character — SOUL.md"],
  identity: ["field.file-identity", "Its name — IDENTITY.md"],
  user: ["field.file-user", "Who you are — USER.md"],
  agents: ["field.file-agents", "AGENTS.md in the project folder"],
  memory: ["field.file-memory", "What you wrote down — MEMORY.md"],
  heartbeat: ["field.file-heartbeat", "The list it reads — HEARTBEAT.md"],
  sop: ["field.file-sop", "The steps — SOP.md"],
  tools: ["field.file-tools", "Your notes — TOOLS.md"],
};

/**
 * What the owner is told about one file under its switch: whether it was found, how big it is, and
 * what that means for their next task. Assembled through `t()` rather than written in English here,
 * because a file's name and size are the only parts that are not words.
 */
const noteKeys = {
  off: ["settings.file.off", "Not read. Turn it on above."],
  missing: ["settings.file.missing", "Not written yet. Make the file and it will be read."],
  empty: ["settings.file.empty", "{name} is empty, which is taken to mean there is nothing to say."],
  carried: ["settings.file.carried", "{name}, {size} kB, read at the start of every task."],
  announced: ["settings.file.announced", "{name}, {size} kB. Your assistant knows it is there and reads it if the work calls for it."],
  "no room": ["settings.file.no-room", "{name}, {size} kB. Switched on, but the others filled the room, so it is named to your assistant instead."],
  // Wave mac2 (guards): the workspace folder is not trusted, so its file is not read.
  "not trusted": ["settings.file.not-trusted", "Not read: this workspace folder is not trusted. Trust it under Permissions to have it read."],
};
function noteFor(report) {
  const [key] = noteKeys[report?.outcome ?? "missing"] ?? noteKeys.missing;
  return t(key, { name: report?.name ?? "", size: Math.round((report?.bytes ?? 0) / 100) / 10 });
}
/** Lines that read as though they hand out permission, which a file cannot do. */
function refusals(report) {
  if (!report?.permissionShaped?.length) return null;
  const note = el("p", t("settings.file.permission-shaped", { count: report.permissionShaped.length }), "field-note");
  note.dataset.tCount = String(report.permissionShaped.length);
  return note;
}

function switchRow(key, report, state, onChange) {
  const row = document.createDocumentFragment();
  const [labelKey, labelText] = fileNames[key];
  const label = el("label", labelText);
  label.dataset.t = labelKey;
  label.htmlFor = `context-switch-${key}`;
  const select = el("select");
  select.id = `context-switch-${key}`;
  for (const [value, key2, words] of positions) {
    const option = el("option", words, undefined);
    option.value = value;
    option.dataset.t = key2;
    if (value === state) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select, el("p", noteFor(report), "field-note"));
  const refused = refusals(report);
  if (refused) row.append(refused);
  return row;
}

function buildCard(spec, reports, settings, save) {
  const card = el("section", undefined, "card");
  card.id = spec.id;
  card.dataset.home = spec.home;
  // DG-032: on the Assistant page this card's title repeats the bucket heading above it, which the
  // sample does not show twice. The heading still belongs to the card -- it is what gives the page
  // its structure and what a screen reader announces -- so it is hidden, not removed.
  const heading = el(spec.inSection ? "h4" : "h2", spec.title[1]);
  heading.dataset.t = spec.title[0];
  if (spec.inSection) heading.className = "sr-only";
  card.append(heading);
  const purpose = el("p", spec.purpose[1]);
  purpose.dataset.t = spec.purpose[0];
  card.append(purpose);
  const status = el("p", undefined, "meta");
  status.setAttribute("role", "status");
  const keep = async (button) => {
    if (button) button.disabled = true;
    try {
      await save({ files: chosen });
      status.textContent = "Saved. It applies to your next task.";
    } catch (error) {
      status.textContent = error.message;
    } finally { if (button) button.disabled = false; }
  };
  const chosen = {};
  for (const key of spec.files) {
    chosen[key] = settings.files?.[key] ?? "off";
    card.append(switchRow(key, reports.find((entry) => entry.key === key), chosen[key], (value) => {
      chosen[key] = value;
      if (spec.inSection) void keep();
    }));
  }
  const note = el("p",
    "A file can change how your assistant works and how it talks to you. It cannot give it permission it does not already have — your approval rules decide that, every time a tool runs.",
    "subtle");
  note.dataset.t = "settings.note.files-cannot-grant";
  if (spec.inSection) { card.append(note, status); return card; }
  const button = el("button", "Save");
  button.dataset.t = "action.save";
  button.type = "button";
  button.addEventListener("click", () => keep(button));
  card.append(note, button, status);
  return card;
}

/** Draws the six cards and lets layout.js put each one where docs/places.md says it belongs. */
export async function drawContextFiles() {
  let state;
  try {
    state = await api("context-files");
  } catch { return; }
  const save = async (body) => {
    const saved = await api("context-files", body);
    state.settings = saved;
    return saved;
  };
  for (const spec of cards) {
    document.getElementById(spec.id)?.remove();
    document.body.append(buildCard(spec, state.files ?? [], state.settings ?? { files: {} }, save));
  }
}

/* These read the owner's settings, which needs the session, so they are drawn on the way in as well
   as at load: on a fresh window the token is not there yet and the first attempt comes back empty. */
if (typeof document !== "undefined") {
  globalThis.branchContextFilesReady = () => { drawContextFiles().catch(() => {}); };
  /* The notes under each switch are assembled from a file's own name and size, so they cannot be
     retranslated in place the way marked-up words are. The cards are simply drawn again. */
  document.addEventListener("branch-language", () => { drawContextFiles().catch(() => {}); });
  drawContextFiles().catch(() => {});
}
