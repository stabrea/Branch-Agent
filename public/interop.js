/* mac4/bucket-20: two cards, each placed by public/layout.js through data-home.

   1. Customize → Connections: "Working with other agents and tools" — the owner's three-way switch
      for each part, the programs lending tools right now, and carrying a conversation on somewhere
      else (the key is shown here once and never given to the model).
   2. Customize → Specialists: "Ways of working and shared assistants" — the modes (built in, yours,
      this folder's), adding one, and a market of shared assistants: look, bring one in, publish.

   It also opens a conversation handed over from another device (#handoff=<id>) once signed in. */
import { api, openConversation } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function labelled(id, key, english, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function statusLine() {
  const node = make("p", "subtle");
  node.setAttribute("role", "status");
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "interop.saved"; node.textContent = say("interop.saved", "Saved."); };
function actionButton(key, english, handler, quiet = false) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}

const POSITIONS = [
  ["off", "field.switch-off", "Off"],
  ["on", "field.switch-on", "On"],
  ["when-needed", "field.switch-when-needed", "Only when it is needed"],
];
const PARTS = {
  "agent-protocol": ["interop.part.agentProtocol", "Taking work over the Agent Protocol (other agents and test harnesses)"],
  "client-tools": ["interop.part.clientTools", "Tools lent by a program on this computer"],
  modes: ["interop.part.modes", "Ways of working (modes)"],
  "project-routing": ["interop.part.projectRouting", "Choosing the project for a request"],
  fleet: ["interop.part.fleet", "Looking after several assistants at once"],
  handoff: ["interop.part.handoff", "Carrying on a conversation somewhere else"],
  "flow-search": ["interop.part.flowSearch", "Finding a better flow automatically"],
  "agent-market": ["interop.part.agentMarket", "Sharing and bringing in whole assistants"],
};

function switchRow(part, mode, status) {
  const [key, english] = PARTS[part] ?? ["", part];
  const select = document.createElement("select");
  for (const [value, optionKey, optionEnglish] of POSITIONS) {
    const option = make("option", "", optionKey, optionEnglish);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    try {
      await api("interop/switch", { part, mode: select.value });
      done(status);
      /* These three change what the cards themselves show. */
      if (["modes", "agent-market", "handoff"].includes(part)) await drawCards();
    } catch (error) { tell(status, error); }
  });
  return labelled(`interop-switch-${part}`, key, english, select);
}

function handoffBlock(sessions) {
  const heading = make("h3", "", "interop.handoff.title", "Carry on a conversation on another device");
  const pick = document.createElement("select");
  for (const session of sessions) {
    const option = plain("option", (session.opening || session.sessionId).slice(0, 60));
    option.value = session.sessionId;
    pick.append(option);
  }
  const minutes = document.createElement("input");
  minutes.type = "number"; minutes.min = "5"; minutes.max = "240"; minutes.value = "30";
  const result = make("p", "field-note");
  const go = actionButton("interop.handoff.go", "Make a link and a key", async () => {
    try {
      const made = await api("interop/handoff", { sessionId: pick.value, to: "device", minutes: Number(minutes.value) });
      result.replaceChildren(plain("span", `${made.link}  ·  ${made.key}  ·  ${made.expiresAt.slice(11, 16)} UTC`));
    } catch (error) { tell(result, error); }
  }, true);
  const note = make("p", "subtle", "interop.handoff.note", "The key works for the minutes you choose, may look and start tasks, and is shown only here, once.");
  return [heading, ...labelled("interop-handoff-session", "interop.handoff.which", "Conversation", pick),
    ...labelled("interop-handoff-minutes", "interop.handoff.minutes", "Minutes the key works for", minutes), note, row(go), result];
}

function connectionsCard(state, sessions) {
  const card = make("section", "card");
  card.id = "interop-card";
  card.dataset.home = "customize:connections";
  const status = statusLine();
  card.append(make("h2", "", "interop.card.title", "Working with other agents and tools"),
    make("p", "subtle", "interop.card.purpose", "Let other agents and programs work with Branch, and Branch with them. Every part starts off."));
  for (const { part, mode } of state.parts) card.append(...switchRow(part, mode, status));
  card.append(status, make("h3", "", "interop.programs.title", "Programs lending tools now"));
  if (!state.programs.length) card.append(make("p", "subtle", "interop.programs.none", "None are connected."));
  for (const program of state.programs) card.append(plain("p", `${program.client}: ${program.tools.join(", ")}`, "field-note"));
  if (state.parts.find((p) => p.part === "handoff")?.mode !== "off") card.append(...handoffBlock(sessions));
  return card;
}

function modeList(modes, status, redraw) {
  const list = document.createElement("ul");
  for (const mode of modes) {
    const item = plain("li", `${mode.name} (${mode.slug}) — ${mode.whenToUse || mode.role}`);
    if (mode.origin === "yours")
      item.append(" ", actionButton("interop.modes.remove", "Remove", async () => {
        try { await api(`interop/modes/${mode.slug}`, undefined, "DELETE"); await redraw(); } catch (error) { tell(status, error); }
      }, true));
    list.append(item);
  }
  return list;
}

function modeForm(status, redraw) {
  const fields = { slug: "input", name: "input", role: "textarea", whenToUse: "input", groups: "input" };
  const english = { slug: "Short name", name: "Name", role: "Who it is and how it works", whenToUse: "When to use it", groups: "Toolboxes it may open (comma-separated; empty for all)" };
  const controls = {}, parts = [];
  for (const [field, tag] of Object.entries(fields)) {
    controls[field] = document.createElement(tag);
    parts.push(...labelled(`interop-mode-${field}`, `interop.modes.${field}`, english[field], controls[field]));
  }
  const readOnly = document.createElement("input");
  readOnly.type = "checkbox";
  parts.push(...labelled("interop-mode-readonly", "interop.modes.readOnly", "Looks and answers only", readOnly));
  const add = actionButton("interop.modes.add", "Add this mode", async () => {
    try {
      await api("interop/modes", { slug: controls.slug.value.trim(), name: controls.name.value.trim(), role: controls.role.value.trim(),
        whenToUse: controls.whenToUse.value.trim(), readOnly: readOnly.checked,
        groups: controls.groups.value.split(",").map((g) => g.trim()).filter(Boolean) });
      await redraw();
    } catch (error) { tell(status, error); }
  });
  return [...parts, row(add)];
}

function marketBlock(indexes, status) {
  const address = document.createElement("input");
  address.type = "url";
  address.value = indexes[0] ?? "";
  const found = document.createElement("ul");
  const look = actionButton("interop.market.look", "Look", async () => {
    try {
      const market = await api("interop/market/browse", { url: address.value.trim() });
      found.replaceChildren(...market.agents.map((agent) => {
        const item = plain("li", `${agent.name} — ${agent.summary}`);
        item.append(" ", actionButton("interop.market.bring", "Bring in", async () => {
          try {
            await api("interop/market/install", { url: address.value.trim(), id: agent.id, sections: ["specialists", "procedures", "skills"] });
            done(status);
          } catch (error) { tell(status, error); }
        }, true));
        return item;
      }));
    } catch (error) { tell(status, error); }
  }, true);
  const folder = document.createElement("input");
  folder.value = "market";
  const publish = actionButton("interop.market.publish", "Publish this assistant to the folder", async () => {
    try {
      const made = await api("interop/market/publish", { folder: folder.value.trim(), id: "my-assistant", name: "My assistant" });
      status.textContent = made.files.join(", ");
    } catch (error) { tell(status, error); }
  }, true);
  return [make("h3", "", "interop.market.title", "Shared assistants"),
    make("p", "subtle", "interop.market.purpose", "Only specialists, saved procedures and skills come in; new skills stay off until you switch them on."),
    ...labelled("interop-market-url", "interop.market.address", "Address of a market list", address), row(look), found,
    ...labelled("interop-market-folder", "interop.market.folder", "Folder in your workspace to publish to", folder), row(publish)];
}

async function specialistsCard(state) {
  const card = make("section", "card");
  card.id = "interop-modes-card";
  card.dataset.home = "customize:specialists";
  const status = statusLine();
  card.append(make("h2", "", "interop.modes.title", "Ways of working and shared assistants"),
    make("p", "subtle", "interop.modes.purpose", "A mode is a role with its own reach; the assistant can send a piece of work to one and get the summary back."));
  const modesOn = state.parts.find((p) => p.part === "modes")?.mode !== "off";
  const marketOn = state.parts.find((p) => p.part === "agent-market")?.mode !== "off";
  if (!modesOn && !marketOn) card.append(make("p", "field-note", "interop.modes.off", "Switch on ways of working or shared assistants in Customize → Connections."));
  if (modesOn) {
    const { modes } = await api("interop/modes");
    card.append(modeList(modes, status, drawCards), ...modeForm(status, drawCards));
  }
  if (marketOn) card.append(...marketBlock((await api("interop/market")).indexes, status));
  card.append(status);
  return card;
}

async function drawCards() {
  let state, sessions = [];
  try { state = await api("interop"); } catch { return; }
  try {
    const listed = await api("sessions?limit=10");
    sessions = (Array.isArray(listed) ? listed : listed.sessions ?? []).filter((s) => typeof s.sessionId === "string");
  } catch { /* no conversations to hand on */ }
  $("interop-card")?.remove();
  $("interop-modes-card")?.remove();
  document.body.append(connectionsCard(state, sessions));
  try { document.body.append(await specialistsCard(state)); } catch { /* the rest of the window is unaffected */ }
}

/** #handoff=<conversation id>: open the conversation another device handed over. */
function followHandoff() {
  const id = new URLSearchParams(location.hash.slice(1)).get("handoff");
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) return;
  history.replaceState(null, "", location.pathname + location.search);
  void openConversation(id).catch(() => undefined);
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

whenReady(() => {
  void drawCards();
  followHandoff();
});
addEventListener("hashchange", () => whenReady(followHandoff));
