/* Bucket 15: "Add-ons other people wrote", a card that puts itself in Customize → Plugins
   (data-home, placed by public/layout.js).

   The owner's three-way switch for each part, then — only for the parts that are not off — looking
   at a package before installing it (everything it would add and need, in plain words), the
   installed add-ons with their own switch, the add-ons that come with Branch, add-on lists, the
   owner's filters, Pipelines servers, drafts the assistant wrote, and Branch as a plugin for other
   tools. Nothing on this card installs, switches on or updates anything without a press. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { switchControl, segmented } from "/control-makers.js";

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
function field(id, key, english, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function input(placeholderKey, placeholder) {
  const node = document.createElement("input");
  node.type = "text";
  node.dataset.tPlaceholder = placeholderKey;
  node.placeholder = say(placeholderKey, placeholder);
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}
const status = make("p", "subtle");
status.setAttribute("role", "status");
const tell = (message) => { delete status.dataset.t; status.textContent = message; };
function button(key, english, handler, quiet = false) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { tell(error.message ?? String(error)); } finally { node.disabled = false; }
  });
  return node;
}
const call = (path, body) => api(`plugin-catalog/add-ons${path}`, body);

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "Only when it is needed"]];
const PARTS = {
  packages: ["addons.part.packages", "Installing add-on packages (Branch, Claude Code, Codex and Gemini CLI formats)"],
  lists: ["addons.part.lists", "Add-on lists you name"],
  filters: ["addons.part.filters", "Your own filters on what goes in and out"],
  pipelines: ["addons.part.pipelines", "Reading a Pipelines server"],
  drafts: ["addons.part.drafts", "Letting the assistant draft an add-on for you to review"],
  search: ["addons.part.search", "Search sources that plugins bring"],
  export: ["addons.part.export", "Branch as a plugin for Claude Code and Codex"],
};

function switches(state) {
  const nodes = [];
  for (const { part } of state.parts) {
    const [key, english] = PARTS[part] ?? ["", part];
    const control = segmented({
      id: `addons-${part}`,
      options: POSITIONS,
      value: state.settings.modes[part],
      onChange: async (value) => {
        try { await call("/settings", { modes: { [part]: value } }); await draw(); } catch (error) { tell(error.message); }
      }
    });
    nodes.push(...field(`addons-${part}`, key, english, control));
  }
  const wall = switchControl({
    id: "addons-wall",
    checked: state.settings.wallEveryPlugin,
    onChange: async (checked) => {
      try { await call("/settings", { wallEveryPlugin: checked }); tell(say("addons.saved", "Saved.")); } catch (error) { tell(error.message); }
    }
  });
  const label = document.createElement("label");
  label.append(wall, make("span", "", "addons.wallEvery", "Also run plugin files I put in the plugins folder myself in their own walled program"));
  nodes.push(label);
  if (state.windows) {
    const weak = switchControl({
      id: "addons-windows-without-wall",
      checked: state.settings.windowsWithoutWall,
      onChange: async (checked) => {
        try { await call("/settings", { windowsWithoutWall: checked }); tell(say("addons.saved", "Saved.")); } catch (error) { tell(error.message); }
      }
    });
    const weakLabel = document.createElement("label");
    weakLabel.append(weak, make("span", "", "addons.windowsWithoutWall", "Run add-on code on Windows without the wall (Windows cannot keep it from your files and the internet)"));
    nodes.push(weakLabel);
  }
  return nodes;
}

/** What a package would add and need, shown before the yes. */
function lookResult(look, install) {
  const box = document.createElement("div");
  box.append(plain("strong", `${look.offer.name} ${look.offer.version}`), plain("p", look.offer.description, "subtle"));
  const needs = document.createElement("ul");
  for (const line of [...look.needs, ...look.offer.leftOut]) needs.append(plain("li", line));
  box.append(make("h3", "", "addons.look.needs", "What it would add and need"), needs);
  if (look.refused) { box.append(plain("p", look.refused, "field-note")); return box; }
  box.append(plain("p", `${say("addons.look.fingerprint", "Fingerprint")}: ${look.offer.sha256.slice(0, 16)}…`, "field-note"),
    row(button("addons.look.install", "Install it, switched off", () => install(look.offer.sha256))));
  return box;
}

function packagesBlock(state) {
  const block = [make("h3", "", "addons.packages.title", "Look at a package")];
  const source = input("addons.packages.where", "The folder or file, in full");
  const shown = document.createElement("div");
  block.push(...field("addons-source", "addons.packages.source", "Where the package is", source), shown,
    row(button("addons.packages.look", "Look at it", async () => {
      const look = await call("/look", { source: source.value });
      shown.replaceChildren(lookResult(look, async (sha256) => { await call("/install", { source: source.value, sha256 }); await draw(); tell(say("addons.done.installed", "Installed, switched off.")); }));
    })));
  for (const look of state.bundled) {
    block.push(plain("p", `${say("addons.bundled", "Comes with Branch")}: ${look.offer.name}`, "field-note"), lookResult(look, async (sha256) => {
      await call("/bundled/install", { id: look.offer.id, sha256 }); await draw();
    }));
  }
  return block;
}

function installedBlock(state) {
  const block = [make("h3", "", "addons.installed.title", "Installed add-ons")];
  if (!state.installed.length) block.push(make("p", "subtle", "addons.installed.none", "None yet."));
  for (const record of state.installed) {
    const item = document.createElement("div");
    item.append(plain("strong", `${record.name} ${record.version}`),
      make("p", "meta", record.enabled ? "addons.installed.on" : "addons.installed.off", record.enabled ? "On." : "Off. Nothing from it is in use."));
    if (!record.unchanged) item.append(make("p", "field-note", "addons.installed.changed", "Its files changed after you installed it, so it cannot be switched on."));
    if (record.plugin) item.append(make("p", "meta", "addons.installed.reach", "It may reach:"),
      plain("p", record.plugin.hosts.length ? record.plugin.hosts.join(", ") : say("addons.installed.noReach", "no web address"), "meta"));
    if (record.grew?.length) item.append(make("p", "field-note", "addons.installed.grew", "This version asks for more than the one before. Read the ticks before switching it on:"),
      plain("p", record.grew.join(", "), "field-note"));
    const allowed = new Set(record.plugin?.permissions ?? []);
    for (const permission of record.plugin?.permissions ?? []) {
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = true;
      tick.addEventListener("change", () => { if (tick.checked) allowed.add(permission); else allowed.delete(permission); });
      const label = plain("label", ` ${permission}`);
      label.prepend(tick);
      item.append(label);
    }
    item.append(row(
      button(record.enabled ? "addons.switch.off" : "addons.switch.on", record.enabled ? "Switch it off" : "Switch it on", async () => {
        const answer = await call("/switch", { id: record.id, on: !record.enabled, ...(record.plugin ? { allow: [...allowed] } : {}) });
        await draw();
        if (answer.notes?.length) tell(answer.notes.join(" "));
      }),
      button("addons.remove", "Remove", async () => { const answer = await call("/remove", { id: record.id }); await draw(); if (answer.kept.length) tell(answer.kept.join(" ")); }, true)));
    block.push(item);
  }
  return block;
}

function listsBlock() {
  const address = input("addons.lists.where", "A web address (https) or a folder, in full");
  const shown = document.createElement("div");
  return [make("h3", "", "addons.lists.title", "Add-on lists"), ...field("addons-list", "addons.lists.address", "List", address), shown,
    row(button("addons.lists.browse", "Look at the list", async () => {
      const list = await call("/lists/browse", { address: address.value });
      shown.replaceChildren(plain("strong", list.name));
      for (const entry of list.addOns) {
        const line = row(plain("span", `${entry.name} ${entry.version} (${entry.signed}) ${entry.note}${entry.sha256 ? ` ${say("addons.look.fingerprint", "Fingerprint")}: ${entry.sha256.slice(0, 16)}…` : ""}`));
        if (entry.installable && entry.sha256) line.append(button("addons.lists.install", "Install, switched off", async () => { await call("/lists/install", { address: list.address, id: entry.id, sha256: entry.sha256 }); await draw(); }));
        shown.append(line);
      }
    }), button("addons.lists.updates", "Check for newer versions", async () => {
      const { updates } = await call("/lists/updates", {});
      shown.replaceChildren(updates.length ? "" : make("p", "subtle", "addons.lists.current", "Everything is up to date."));
      for (const update of updates)
        shown.append(row(plain("span", `${update.id}: ${update.from} → ${update.to}`),
          button("addons.lists.take", "Take it (arrives switched off)", async () => { await call("/lists/update", { id: update.id }); await draw(); })));
    }, true))];
}

function filtersBlock(state) {
  const block = [make("h3", "", "addons.filters.title", "Your filters")];
  for (const rule of state.filters) {
    block.push(row(plain("span", `${rule.name} — ${rule.action}, ${rule.stage}${rule.from === "you" ? "" : ` (${rule.from})`}`),
      button(rule.enabled ? "addons.switch.off" : "addons.switch.on", rule.enabled ? "Switch it off" : "Switch it on", async () => { await call("/filters", { ...rule, enabled: !rule.enabled }); await draw(); }),
      button("addons.remove", "Remove", async () => { await call("/filters/remove", { id: rule.id }); await draw(); }, true)));
  }
  const name = input("addons.filters.nameHint", "For example: Take out card numbers");
  const words = input("addons.filters.wordsHint", "Words to look for, separated by commas");
  const action = document.createElement("select");
  for (const [value, key, english] of [["redact", "addons.filters.redact", "Take them out"], ["block", "addons.filters.block", "Stop the message"], ["note", "addons.filters.note", "Add a note"]]) {
    const option = make("option", "", key, english);
    option.value = value;
    action.append(option);
  }
  block.push(...field("addons-filter-name", "addons.filters.name", "Name", name), ...field("addons-filter-words", "addons.filters.words", "Words", words),
    ...field("addons-filter-action", "addons.filters.action", "What to do", action),
    row(button("addons.filters.add", "Add the filter", async () => {
      const id = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "filter";
      await call("/filters", { id, name: name.value, match: words.value, action: action.value });
      await draw();
    })));
  return block;
}

function pipelinesBlock(state) {
  const address = input("addons.pipelines.where", "https://your-server/v1");
  const key = input("addons.pipelines.keyHint", "Saved secret name, if it needs a key");
  const shown = document.createElement("div");
  const block = [make("h3", "", "addons.pipelines.title", "Pipelines servers"), make("p", "subtle", "addons.pipelines.purpose", "Branch only reads what a Pipelines server runs. Add or change pipelines on the server itself."),
    ...field("addons-pipes", "addons.pipelines.address", "Address", address), ...field("addons-pipes-key", "addons.pipelines.key", "Key", key),
    row(button("addons.save", "Save", async () => { await call("/pipelines", { address: address.value, ...(key.value ? { keyName: key.value } : {}) }); await draw(); }))];
  for (const server of state.pipelines)
    block.push(row(plain("span", server.address), button("addons.pipelines.list", "Show its pipelines", async () => {
      const { pipelines } = await call("/pipelines/list", { address: server.address });
      shown.replaceChildren(...pipelines.map((pipeline) => plain("p", `${pipeline.name} (${pipeline.type})`, "field-note")));
    }, true), button("addons.remove", "Remove", async () => { await call("/pipelines/forget", { address: server.address }); await draw(); }, true)));
  block.push(shown);
  return block;
}

function draftsBlock(state) {
  const block = [make("h3", "", "addons.drafts.title", "Drafts your assistant wrote")];
  if (!state.drafts.length) block.push(make("p", "subtle", "addons.drafts.none", "None. A draft is never installed until you install it here."));
  for (const draft of state.drafts) {
    const code = plain("pre", draft.code);
    code.className = "field-note";
    // A long line wraps rather than pushing the page sideways on a narrow window.
    code.style.whiteSpace = "pre-wrap";
    const shown = document.createElement("div");
    block.push(plain("strong", draft.name), plain("p", draft.description, "subtle"), code, shown,
      row(button("addons.packages.look", "Look at it", async () => {
        const look = await call("/drafts/look", { id: draft.id });
        shown.replaceChildren(lookResult(look, async (sha256) => { await call("/drafts/install", { id: draft.id, sha256 }); await draw(); }));
      }), button("addons.drafts.discard", "Throw it away", async () => { await call("/drafts/discard", { id: draft.id }); await draw(); }, true)));
  }
  return block;
}

function exportBlock() {
  const target = document.createElement("select");
  for (const [value, english] of [["claude-code", "Claude Code"], ["codex", "Codex"]]) {
    const option = plain("option", english);
    option.value = value;
    target.append(option);
  }
  const folder = input("addons.export.where", "An empty folder, in full");
  return [make("h3", "", "addons.export.title", "Branch as a plugin"),
    make("p", "subtle", "addons.export.purpose", "Writes a small plugin into a folder you choose. Add that folder in the other tool yourself; Branch never changes its settings."),
    ...field("addons-export-tool", "addons.export.tool", "For", target), ...field("addons-export-folder", "addons.export.folder", "Folder", folder),
    row(button("addons.export.write", "Write the plugin", async () => { const wrote = await call("/export", { target: target.value, folder: folder.value }); tell(wrote.files.join(", ")); }),
      button("addons.export.check", "Check it", async () => { const found = await call("/export/status", { folder: folder.value }); tell(found.written ? `${found.target} ${found.version}${found.current ? "" : " ↻"}${found.changed.length ? ` — ${found.changed.join(", ")}` : ""}` : say("addons.export.notOurs", "Branch did not write that folder.")); }, true),
      button("addons.remove", "Remove", async () => { const gone = await call("/export/remove", { folder: folder.value }); tell(gone.kept.length ? gone.kept.join(", ") : say("addons.export.removed", "Removed.")); }, true))];
}

async function draw() {
  let state;
  try { state = await call(""); } catch { return; }
  $("add-ons-card")?.remove();
  const card = make("section", "card");
  card.id = "add-ons-card";
  card.dataset.home = "customize:plugins";
  card.style.overflowWrap = "anywhere"; // long paths and addresses wrap at 400 px
  const on = (part) => state.settings.modes[part] !== "off";
  card.append(make("h2", "", "addons.card.title", "Add-ons other people wrote"),
    make("p", "subtle", "addons.card.purpose", "Packages, lists and filters from other people. Each part starts off, nothing installs or switches on by itself, and add-on code runs walled, apart from Branch."),
    ...switches(state), status, ...installedBlock(state));
  if (on("packages")) card.append(...packagesBlock(state));
  if (on("lists")) card.append(...listsBlock());
  if (on("filters")) card.append(...filtersBlock(state));
  if (on("pipelines")) card.append(...pipelinesBlock(state));
  if (on("drafts")) card.append(...draftsBlock(state));
  if (on("export")) card.append(...exportBlock());
  document.body.append(card);
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

whenReady(() => void draw());
document.addEventListener("branch-place", (event) => { if (event.detail?.view === "customize:plugins") void draw(); });
