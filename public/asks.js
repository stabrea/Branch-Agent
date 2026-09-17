/* mac6/bucket-23: the smaller asks, one card in each part's home, each placed by public/layout.js
   through data-home. Every part has the owner's three-way switch and starts off.

   settings:general             Project boards
   settings:data                Counting how Branch is used (consent first)
   settings:computer            Other computers running Branch
   settings:models:connection   Other agents answering a conversation
   library:made                 Quick answers, pages kept, long articles, live tool pages
   library:documents            Bringing in new items with a cursor
   library:memory               A Hindsight memory server
   customize:skills             Sending requests where they belong
   customize:connections        Steps for other apps, MCP examples, the app-server protocol */
import { api } from "/app.js";
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
function field(tag, value = "", type = "") {
  const node = document.createElement(tag);
  if (type) node.type = type;
  node.value = value;
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "asks.saved"; node.textContent = say("asks.saved", "Saved."); };
function button(key, english, handler, quiet = true) {
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

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "Only when it is needed"]];
const PARTS = {
  "project-board": ["asks.part.projectBoard", "Project boards"],
  "answer-engine": ["asks.part.answerEngine", "Quick answers from the web, with sources"],
  "answer-pages": ["asks.part.answerPages", "Keeping answers as pages"],
  "article-writer": ["asks.part.articleWriter", "Writing a long article from research"],
  "intent-pipeline": ["asks.part.intentPipeline", "Sending requests where they belong"],
  "source-sync": ["asks.part.sourceSync", "Bringing in new items"],
  hindsight: ["asks.part.hindsight", "A Hindsight memory server"],
  "app-blocks": ["asks.part.appBlocks", "Steps for other apps"],
  analytics: ["asks.part.analytics", "Counting how Branch is used"],
  "live-surfaces": ["asks.part.liveSurfaces", "Tool pages that keep themselves up to date"],
  nodes: ["asks.part.nodes", "Other computers running Branch"],
  "app-server": ["asks.part.appServer", "Letting an editor drive Branch (app-server protocol)"],
  runtimes: ["asks.part.runtimes", "Other agents answering a conversation"],
};

/** The part's three-way switch; a change redraws the cards, since what they show depends on it. */
function switchFor(part, modes, status) {
  const select = document.createElement("select");
  for (const [value, key, english] of POSITIONS) {
    const option = make("option", "", key, english);
    option.value = value;
    option.selected = value === modes[part];
    select.append(option);
  }
  select.addEventListener("change", async () => {
    try { await api("asks/switch", { part, mode: select.value }); done(status); await drawCards(); } catch (error) { tell(status, error); }
  });
  const [key, english] = PARTS[part];
  return labelled(`asks-switch-${part}`, key, english, select);
}

function card(id, home, titleKey, title, purposeKey, purpose) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = home;
  node.append(make("h2", "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  return { node, status };
}

/** Lines of "a | b | c" into rows, for the small list editors on these cards. */
const lines = (text) => text.split("\n").map((line) => line.split("|").map((part) => part.trim())).filter((parts) => parts[0]);

/* ---------- settings:general — project boards ---------- */
async function boardCard(modes) {
  const { node, status } = card("asks-board-card", "settings:general", "asks.board.title", "Project boards",
    "asks.board.purpose", "See the flows, schedules and triggers that belong to a project, and the tasks done under it.");
  node.append(...switchFor("project-board", modes, status));
  if (modes["project-board"] !== "off") {
    const board = await api("asks/projects/board");
    node.append(plain("h3", board.project.name));
    for (const [key, english, items] of [["asks.board.flows", "Flows", board.flows], ["asks.board.schedules", "Schedules", board.schedules], ["asks.board.triggers", "Triggers", board.triggers]])
      node.append(make("p", "field-note", key, english), plain("p", items.map((i) => i.name).join(", ") || "—"));
    node.append(make("p", "field-note", "asks.board.tasks", "Recent tasks"), plain("p", board.tasks.map((task) => task.prompt).slice(0, 5).join(" · ") || "—"));
  }
  node.append(status);
  return node;
}

/* ---------- settings:data — consented counts ---------- */
async function analyticsCard(modes) {
  const { node, status } = card("asks-analytics-card", "settings:data", "asks.analytics.title", "Counting how Branch is used",
    "asks.analytics.purpose", "Counts per day of a few named events, only with your yes. Never what you typed.");
  node.append(...switchFor("analytics", modes, status));
  if (modes.analytics !== "off") {
    const view = await api("asks/analytics");
    const answer = (consent) => async () => { try { await api("asks/analytics", { consent }); await drawCards(); } catch (error) { tell(status, error); } };
    const address = field("input", view.analytics.sendTo ?? "", "url");
    node.append(make("p", "", "asks.analytics.question", view.analytics.question),
      row(button("asks.analytics.yes", "Yes, count", answer("yes"), false), button("asks.analytics.no", "No, and wipe the counts", answer("no"))),
      ...labelled("asks-analytics-address", "asks.analytics.address", "Your own collector (https), optional", address),
      row(button("asks.save", "Save", async () => { try { await api("asks/analytics", { sendTo: address.value.trim() || null }); done(status); } catch (error) { tell(status, error); } }),
        button("asks.analytics.send", "Send the counts now", async () => { try { status.textContent = (await api("asks/analytics/send", {})).reason; } catch (error) { tell(status, error); } })),
      plain("p", view.counts.slice(0, 12).map((c) => `${c.day} ${c.event}: ${c.count}`).join(" · ") || "—", "field-note"));
  }
  node.append(status);
  return node;
}

/* ---------- settings:computer — other Branch computers ---------- */
async function nodesCard(modes) {
  const { node, status } = card("asks-nodes-card", "settings:computer", "asks.nodes.title", "Other computers running Branch",
    "asks.nodes.purpose", "Hand tasks to your other computers; a computer that is down or busy is passed over.");
  node.append(...switchFor("nodes", modes, status));
  if (modes.nodes !== "off") {
    const { nodes } = await api("asks/nodes");
    const list = field("textarea", nodes.map((n) => [n.id, n.name, n.address, n.secret, n.labels.join(" ")].join(" | ")).join("\n"));
    const save = async () => {
      const rows = lines(list.value).map(([id, name, address, secret, labels]) => ({ id, name, address, secret, labels: (labels ?? "").split(/\s+/).filter(Boolean) }));
      try { await api("asks/nodes", { nodes: rows }); done(status); } catch (error) { tell(status, error); }
    };
    const check = async () => {
      try { status.textContent = (await api("asks/nodes/check", {})).nodes.map((h) => `${h.name}: ${h.ok ? "✓" : h.reason}`).join(" · "); } catch (error) { tell(status, error); }
    };
    node.append(...labelled("asks-nodes-list", "asks.nodes.list", "One per line: short name | name | address | saved secret with its key | labels", list),
      row(button("asks.save", "Save", save), button("asks.nodes.check", "Check them now", check)));
  }
  node.append(status);
  return node;
}

/* ---------- settings:models:connection — other agents ---------- */
async function runtimesCard(modes) {
  const { node, status } = card("asks-runtimes-card", "settings:models:connection", "asks.runtimes.title", "Other agents answering a conversation",
    "asks.runtimes.purpose", "Add a coding agent already on this computer as a connection; it uses its own sign-in.");
  node.append(...switchFor("runtimes", modes, status));
  if (modes.runtimes !== "off") {
    const { runtimes } = await api("asks/runtimes");
    for (const runtime of runtimes.filter((r) => r.kind !== "builtin")) {
      const found = runtime.installed ? say("asks.runtimes.found", "found on this computer") : say("asks.runtimes.missing", "not found on this computer");
      const change = runtime.added
        ? button("asks.runtimes.remove", "Remove", async () => { try { await api("asks/runtimes/remove", { id: runtime.id }); await drawCards(); } catch (error) { tell(status, error); } })
        : button("asks.runtimes.add", "Add", async () => { try { await api("asks/runtimes/add", { id: runtime.id }); await drawCards(); } catch (error) { tell(status, error); } });
      node.append(plain("p", `${runtime.name} — ${found}`, "field-note"), row(change));
    }
  }
  node.append(status);
  return node;
}

/* ---------- library:made — answers, pages, articles, live pages ---------- */
function pageRow(page, status) {
  const item = plain("li", `${page.title} (${page.updatedAt.slice(0, 10)})`);
  item.append(" ", button("asks.pages.export", "Save as a file", async () => {
    try {
      const file = await api(`asks/pages/${page.id}/export`);
      const address = URL.createObjectURL(new Blob([file.html], { type: "text/html" }));
      const link = document.createElement("a");
      link.href = address; link.download = file.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(address), 10000);
    } catch (error) { tell(status, error); }
  }), " ", button("asks.pages.remove", "Remove", async () => { try { await api(`asks/pages/${page.id}/remove`, {}); await drawCards(); } catch (error) { tell(status, error); } }));
  return item;
}

async function madeCard(modes) {
  const { node, status } = card("asks-made-card", "library:made", "asks.made.title", "Answers, pages and articles",
    "asks.made.purpose", "Quick answers with their sources, kept as pages you can hand on, and long articles written from research.");
  for (const part of ["answer-engine", "answer-pages", "article-writer", "live-surfaces"]) node.append(...switchFor(part, modes, status));
  if (modes["answer-engine"] !== "off") {
    const question = field("input");
    const answer = make("p", "field-note");
    node.append(...labelled("asks-answer-question", "asks.answer.question", "Question", question),
      row(button("asks.answer.ask", "Answer with sources", async () => {
        try { answer.textContent = (await api("asks/answer", { question: question.value, keep: modes["answer-pages"] !== "off" })).answer; await drawPages(); } catch (error) { tell(status, error); }
      }, false)), answer);
  }
  if (modes["answer-pages"] !== "off") {
    const list = document.createElement("ul");
    list.id = "asks-pages-list";
    node.append(make("h3", "", "asks.pages.title", "Pages kept"), list);
  }
  if (modes["live-surfaces"] !== "off") node.append(...await surfacesBlock(status));
  node.append(status);
  return node;
}

async function drawPages() {
  const list = $("asks-pages-list");
  if (!list) return;
  const { pages } = await api("asks/pages");
  const status = $("asks-made-card")?.querySelector("[role=status]") ?? make("p");
  list.replaceChildren(...pages.map((page) => pageRow(page, status)));
  if (!pages.length) list.append(make("li", "subtle", "asks.pages.none", "No pages yet."));
}

async function surfacesBlock(status) {
  const { surfaces } = await api("asks/surfaces");
  const tool = field("input"), every = field("input", "300", "number");
  const frames = surfaces.map((surface) => {
    const frame = document.createElement("iframe");
    frame.sandbox = "";
    frame.title = surface.title;
    frame.src = `/asks-surface/${surface.page}`;
    frame.style.width = "100%";
    return frame;
  });
  return [make("h3", "", "asks.surfaces.title", "Live tool pages"), ...frames,
    ...labelled("asks-surface-tool", "asks.surfaces.tool", "Tool to ask again", tool),
    ...labelled("asks-surface-every", "asks.surfaces.every", "Every how many seconds", every),
    row(button("asks.surfaces.add", "Pin it", async () => {
      try { await api("asks/surfaces", { title: tool.value.trim(), tool: tool.value.trim(), everySeconds: Number(every.value) }); await drawCards(); } catch (error) { tell(status, error); }
    }))];
}

/* ---------- library:documents — sources ---------- */
async function sourcesCard(modes) {
  const { node, status } = card("asks-sources-card", "library:documents", "asks.sources.title", "Bringing in new items",
    "asks.sources.purpose", "New GitHub issues, mail and Telegram messages since the last time, written into sources/ in your workspace.");
  node.append(...switchFor("source-sync", modes, status));
  if (modes["source-sync"] !== "off") {
    const view = await api("asks/sources");
    const list = field("textarea", view.sources.map((s) => [s.id, s.kind, s.target, s.secret].join(" | ")).join("\n"));
    node.append(...labelled("asks-sources-list", "asks.sources.list", "One per line: short name | github-issues, imap or telegram | where | saved secret", list),
      row(button("asks.save", "Save", async () => {
        try { await api("asks/sources", { sources: lines(list.value).map(([id, kind, target, secret]) => ({ id, kind, target: target ?? "", secret: secret ?? "" })) }); done(status); } catch (error) { tell(status, error); }
      }), button("asks.sources.sync", "Bring in what is new", async () => {
        try { status.textContent = (await api("asks/sources/sync", {})).results.map((r) => `${r.id}: ${r.error ?? r.added}`).join(" · "); } catch (error) { tell(status, error); }
      })),
      plain("p", view.status.map((s) => `${s.id}: ${s.items} (${s.syncedAt?.slice(0, 16) ?? "—"})`).join(" · "), "field-note"));
  }
  node.append(status);
  return node;
}

/* ---------- library:memory — Hindsight ---------- */
async function hindsightCard(modes) {
  const { node, status } = card("asks-hindsight-card", "library:memory", "asks.hindsight.title", "A Hindsight memory server",
    "asks.hindsight.purpose", "Also keep and find things in your own Hindsight server. Branch's own memory stays as it is.");
  node.append(...switchFor("hindsight", modes, status));
  if (modes.hindsight !== "off") {
    const { hindsight } = await api("asks/hindsight");
    const address = field("input", hindsight.address ?? "", "url"), bank = field("input", hindsight.bank), secret = field("input", hindsight.secret);
    node.append(...labelled("asks-hindsight-address", "asks.hindsight.address", "Server address", address),
      ...labelled("asks-hindsight-bank", "asks.hindsight.bank", "Memory bank", bank),
      ...labelled("asks-hindsight-secret", "asks.hindsight.secret", "Saved secret with its key (optional)", secret),
      row(button("asks.save", "Save", async () => {
        try { await api("asks/hindsight", { address: address.value.trim() || null, bank: bank.value.trim(), secret: secret.value.trim() }); done(status); } catch (error) { tell(status, error); }
      })));
  }
  node.append(status);
  return node;
}

/* ---------- customize:skills — intents ---------- */
async function intentsCard(modes) {
  const { node, status } = card("asks-intents-card", "customize:skills", "asks.intents.title", "Sending requests where they belong",
    "asks.intents.purpose", "Name the kinds of request you make and where each goes: a skill, a specialist, a flow or an instruction.");
  node.append(...switchFor("intent-pipeline", modes, status));
  if (modes["intent-pipeline"] !== "off") {
    const { pipeline } = await api("asks/intents");
    const list = field("textarea", pipeline.intents.map((i) => [i.name, i.words.join(" "), `${i.goesTo.kind}:${i.goesTo.target}`].join(" | ")).join("\n"));
    const trial = field("input"), result = make("p", "field-note");
    node.append(...labelled("asks-intents-list", "asks.intents.list", "One per line: name | words | skill:, specialist:, flow: or instruction: and where", list),
      row(button("asks.save", "Save", async () => {
        const intents = lines(list.value).map(([name, words, goes]) => {
          const [kind, ...target] = (goes ?? "").split(":");
          return { name, words: (words ?? "").split(/\s+/).filter(Boolean), goesTo: { kind: kind.trim(), target: target.join(":").trim() } };
        });
        try { await api("asks/intents", { ...pipeline, intents }); done(status); } catch (error) { tell(status, error); }
      })),
      ...labelled("asks-intents-try", "asks.intents.try", "Try a request", trial),
      row(button("asks.intents.decide", "Where would it go?", async () => {
        try { const d = await api("asks/intents/decide", { request: trial.value }); result.textContent = d.goesTo ? `${d.intent} → ${d.goesTo.kind}: ${d.goesTo.target} (${d.reason})` : d.reason; } catch (error) { tell(status, error); }
      })), result);
  }
  node.append(status);
  return node;
}

/* ---------- customize:connections — app steps, MCP examples, app-server ---------- */
async function connectionsCard(modes) {
  const { node, status } = card("asks-connections-card", "customize:connections", "asks.connections.title", "Steps for other apps and examples",
    "asks.connections.purpose", "Ready-made steps for Slack, Notion, Google Sheets and more, examples of connecting a server, and the app-server door for editors.");
  for (const part of ["app-blocks", "app-server"]) node.append(...switchFor(part, modes, status));
  if (modes["app-server"] !== "off") node.append(make("p", "field-note", "asks.appServer.how", "An editor starts it with: branch app-server"));
  if (modes["app-blocks"] !== "off") {
    const { blocks } = await api("asks/blocks");
    for (const block of blocks) {
      const secret = field("input");
      secret.placeholder = block.ready ? say("asks.blocks.ready", "has a key") : say("asks.blocks.noKey", "no key yet");
      node.append(plain("p", `${block.app}: ${block.name} — ${block.about}`, "field-note"),
        ...labelled(`asks-block-${block.id.replace(".", "-")}`, "asks.blocks.secret", "Saved secret with its key", secret),
        row(button("asks.save", "Save", async () => { try { await api("asks/blocks/key", { block: block.id, secret: secret.value.trim() || null }); done(status); } catch (error) { tell(status, error); } })));
    }
  }
  const { examples } = await api("asks/mcp-examples");
  node.append(make("h3", "", "asks.examples.title", "Examples of connecting a server"));
  for (const example of examples)
    node.append(plain("p", `${example.title} — ${example.about}`, "field-note"),
      row(button("asks.examples.copy", "Copy", async () => { await navigator.clipboard?.writeText(example.file); done(status); })));
  node.append(status);
  return node;
}

const BUILDERS = [boardCard, analyticsCard, nodesCard, runtimesCard, madeCard, sourcesCard, hindsightCard, intentsCard, connectionsCard];
const IDS = ["asks-board-card", "asks-analytics-card", "asks-nodes-card", "asks-runtimes-card", "asks-made-card", "asks-sources-card", "asks-hindsight-card", "asks-intents-card", "asks-connections-card"];

async function drawCards() {
  let modes;
  try { modes = (await api("asks")).modes; } catch { return; }
  for (const [index, build] of BUILDERS.entries()) {
    try {
      const fresh = await build(modes);
      const old = $(IDS[index]);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
  await drawPages().catch(() => undefined);
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

whenReady(() => { void drawCards(); });
