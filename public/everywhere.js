/* DG-154: Branch in the terminal and on your phone, after the approved sample's everywhereDialog.

   One dialog, near the size of the window, with four tabs: Terminal, iPhone, Android and Tablet. Each
   is a small working preview: the terminal takes keys (type and Enter, y/n/a/s, Esc then 1-5, Ctrl K,
   /mode, /settings, /usage, Ctrl C), and the phones and the tablet can be tapped. All four draw one
   sample kept in this file, so an approval answered on the phone shows in the terminal too.

   The sample is sealed off: this file never calls the server, never reads the owner's data folder,
   and never touches a real conversation, setting or mode. /mode here changes the preview's own top
   line. Words have data-t keys in public/locales; no colour is written here (public/everywhere.css). */
import { t } from "/i18n.js";

const say = (key, values) => t(key, values);
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
/** A node whose words follow the language: data-t for plain words, data-t-template when it has values. */
function worded(tag, className, key, values) {
  const node = el(tag, className, say(key, values));
  if (values) node.dataset.tTemplate = key;
  else node.dataset.t = key;
  return node;
}
function tapper(className, key, handler, label) {
  const node = key ? worded("button", className, key) : el("button", className);
  node.type = "button";
  if (label) node.setAttribute("aria-label", say(label));
  node.addEventListener("click", (event) => { event.stopPropagation(); handler(); });
  return node;
}
const ICONS = {
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z", inbox: "M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5",
  automations: "M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z", library: "M5 4h5v16H5zM10 4h4v16h-4zM15 5l4 1-3 15-4-1z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  mic: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3", up: "M12 19V5M6 11l6-6 6 6",
  close: "M6 6l12 12M18 6 6 18",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ew-ico");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/* ---------- the sample the four tabs share ---------- */
const CODE = "python3 tools/compare_quotes.py Documents/quotes --out comparison.csv";
const TRUNKS = [["computer", "▣", "terminal.rail.here"], ["scout", "S", "everywhere.brief.title"], ["ledger", "L", "everywhere.tidy.title"]];
function freshSample() {
  const ask = (yes, no) => ({ kind: "ask", code: CODE, state: "wait", yes, no });
  return {
    convs: {
      quotes: { title: "everywhere.quotes.title", when: "everywhere.today", trunk: "computer", turns: [
        { kind: "you", key: "everywhere.quotes.ask" }, { kind: "step", key: "everywhere.quotes.read" },
        { kind: "step", key: "everywhere.quotes.remembered" }, ask("everywhere.quotes.yes", "everywhere.quotes.no")] },
      brief: { title: "everywhere.brief.title", when: "everywhere.today", trunk: "scout", turns: [
        { kind: "you", key: "everywhere.brief.ask" }, { kind: "answer", key: "everywhere.brief.answer" }] },
      tidy: { title: "everywhere.tidy.title", when: "everywhere.yesterday", trunk: "ledger", turns: [
        { kind: "you", key: "everywhere.tidy.ask" }, { kind: "answer", key: "everywhere.tidy.answer" }] },
    },
    mode: "ask", left: 12, timers: [], ask,
  };
}
const sample = freshSample();
const TABS = [["terminal", "everywhere.tab.terminal"], ["iphone", "everywhere.tab.iphone"], ["android", "everywhere.tab.android"], ["tablet", "everywhere.tab.tablet"]];
const view = { tab: "terminal", dialog: null };
const words = (turn) => (turn.key ? say(turn.key) : turn.text) + (turn.suffix ? `   ${say(turn.suffix)}` : "");
const waitingAsk = (id) => sample.convs[id]?.turns.find((turn) => turn.kind === "ask" && turn.state === "wait") ?? null;
const busy = () => sample.timers.length > 0;
const MODES = [["auto", "mode.auto"], ["ask", "mode.ask"], ["plan", "mode.plan"], ["full", "mode.full"]];
const modeName = () => say(MODES.find(([id]) => id === sample.mode)[1]);

/** Runs later, unless Ctrl C stops the work first. */
function later(ms, work) {
  const id = setTimeout(() => { sample.timers = sample.timers.filter((x) => x !== id); work(); draw(); }, ms);
  sample.timers.push(id);
}
function stopWork() {
  if (!busy()) return false;
  sample.timers.forEach(clearTimeout);
  sample.timers = [];
  return true;
}
/** y, n, a or s: the same answer whichever tab gave it. */
function answer(id, how) {
  const ask = waitingAsk(id);
  if (!ask) return;
  const yes = how !== "n";
  ask.state = yes ? "yes" : "no";
  const turns = sample.convs[id].turns;
  turns.push({ kind: "step", key: yes ? "everywhere.run.ran" : "everywhere.run.refused",
    suffix: { a: "everywhere.run.always", s: "everywhere.run.session" }[how] });
  if (yes) sample.left = Math.max(1, sample.left - 1);
  later(700, () => turns.push({ kind: "answer", key: yes ? ask.yes : ask.no }));
  draw();
}
/** A message from the terminal: a few steps, then a command to approve. */
function runFromTerminal(id, text) {
  const turns = sample.convs[id].turns;
  turns.push({ kind: "you", text });
  const steps = [["everywhere.run.thinking", { name: say("everywhere.agent") }], ["everywhere.run.plan"], ["everywhere.quotes.read"], ["everywhere.quotes.remembered"]];
  steps.forEach(([key, values], index) => later(450 * (index + 1), () => turns.push({ kind: "step", text: say(key, values) })));
  later(450 * (steps.length + 1), () => turns.push(sample.ask("everywhere.run.done", "everywhere.run.notRun")));
  draw();
}
/** A message from a phone or the tablet: a short reply. */
function sendFromDevice(id, text) {
  const turns = sample.convs[id].turns;
  turns.push({ kind: "you", text });
  later(900, () => turns.push({ kind: "answer", key: "everywhere.run.gotIt" }));
  draw();
}

/* ---------- the dialog ---------- */
export function openEverywhere() {
  view.dialog?.close();
  const dialog = el("dialog", "ew-dlg");
  dialog.id = "ew-dialog";
  dialog.setAttribute("aria-labelledby", "ew-title");
  const head = el("div", "ew-head");
  const title = worded("h2", "ew-title", "everywhere.title");
  title.id = "ew-title";
  const close = tapper("ew-x", null, () => dialog.close(), "studio.close");
  close.append(icon("close"));
  head.append(title, close);
  const body = el("div", "ew-body");
  body.append(tabStrip(), Object.assign(el("div", "ew-panel"), { id: "ew-panel" }));
  dialog.append(head, body);
  /* Esc inside the terminal is the terminal's own key ("Esc, then 1-5"), not the dialog's. */
  dialog.addEventListener("cancel", (event) => { if (document.activeElement?.id === "ew-tui") event.preventDefault(); });
  dialog.addEventListener("close", () => { dialog.remove(); if (view.dialog === dialog) view.dialog = null; });
  document.body.append(dialog);
  view.dialog = dialog;
  dialog.showModal();
  draw();
  if (view.tab === "terminal") document.getElementById("ew-tui")?.focus();
  return dialog;
}
function tabStrip() {
  const strip = el("div", "ew-tabs");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", say("everywhere.tabs"));
  for (const [id, key] of TABS) {
    const tab = tapper("ew-tab", key, () => chooseTab(id));
    tab.setAttribute("role", "tab");
    tab.dataset.tab = id;
    strip.append(tab);
  }
  strip.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = TABS.findIndex(([id]) => id === view.tab);
    chooseTab(TABS[(at + step + TABS.length) % TABS.length][0]);
    strip.querySelector(`[data-tab="${view.tab}"]`)?.focus();
  });
  return strip;
}
function chooseTab(id) {
  view.tab = id;
  draw();
  if (id === "terminal") document.getElementById("ew-tui")?.focus();
}
/** Draws whichever tab is showing; the terminal keeps its own element so it keeps the keyboard. */
function draw() {
  const panel = document.getElementById("ew-panel");
  if (!panel) return;
  for (const tab of view.dialog.querySelectorAll(".ew-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === view.tab));
    tab.setAttribute("aria-pressed", String(tab.dataset.tab === view.tab));
  }
  panel.dataset.tab = view.tab;
  if (view.tab === "terminal") return drawTerminal(panel);
  const typing = document.activeElement?.id === "ew-ph-in";
  panel.replaceChildren(worded("p", "ew-note ew-note-center", "everywhere.device.note"), deviceStage(view.tab));
  const scroller = panel.querySelector(".ew-dv-scroll");
  if (scroller && PH.view === "conv") scroller.scrollTop = scroller.scrollHeight;
  if (typing) document.getElementById("ew-ph-in")?.focus();
}
document.addEventListener("branch-language", draw);
/* The preview is the owner's: it closes when the window moves to somebody else's profile. */
document.addEventListener("branch-profile", (event) => { if (event.detail?.owner === false) view.dialog?.close(); });

/* ---------- the terminal ---------- */
const PLACES = ["nav.chat", "place.inbox", "place.automations", "place.library", "place.customize"];
const PAGES = ["settings.page.general", "settings.page.models", "settings.page.permissions", "settings.page.appearance", "settings.page.voice", "settings.page.notifications"];
const TU = { place: 1, conv: "quotes", input: "", last: "", sel: 0, find: null, pick: null, esc: false, sub: null };
function drawTerminal(panel) {
  let tui = document.getElementById("ew-tui");
  if (!tui) {
    tui = el("div", "ew-tui");
    tui.id = "ew-tui";
    tui.tabIndex = 0;
    tui.setAttribute("role", "application");
    panel.replaceChildren(worded("p", "ew-note", "everywhere.terminal.note"), tui);
  }
  tui.setAttribute("aria-label", say("everywhere.terminal.label"));
  const main = el("div", "ew-tui-main");
  main.append(terminalRail(), terminalBody(), terminalPane());
  const keys = el("div", "ew-tui-keys");
  keys.append(worded("p", "", "terminal.keys.line"), worded("p", "", "terminal.keys.line2"));
  tui.replaceChildren(terminalTop(), terminalPlaces(), main, el("div", "ew-tui-use", usageLine()), keys);
}
function terminalTop() {
  const top = el("div", "ew-tui-top");
  const here = TU.place === 1 && !TU.sub ? say(sample.convs[TU.conv].title) : say(PLACES[TU.place - 1]);
  top.append(el("span", "ew-tui-brand", "branch"), ` · ${say("terminal.rail.here")} · `, el("b", "", here),
    el("span", "ew-tui-r", `${modeName()} · ${say("everywhere.model")}`));
  return top;
}
function terminalPlaces() {
  const row = el("div", "ew-tui-places");
  PLACES.forEach((key, index) => row.append(el("span", TU.place === index + 1 && !TU.sub ? "on" : "", `${index + 1} ${say(key)}`)));
  return row;
}
function terminalRail() {
  const rail = el("div", "ew-tui-rail");
  for (const [id, glyph, key] of [...TRUNKS, ["phone", "▯", "everywhere.tab.iphone"]]) {
    const mark = el("span", sample.convs[TU.conv].trunk === id ? "on" : "", glyph === "▣" || glyph === "▯" ? glyph : "◆");
    mark.title = say(key);
    rail.append(mark);
  }
  return rail;
}
function terminalPane() {
  const pane = el("div", "ew-tui-pane");
  pane.replaceChildren(el("p", "ew-b", say("pane.activity")), el("p", "ew-dim", say(busy() ? "terminal.pane.working" : "terminal.pane.ready")));
  if (waitingAsk(TU.conv)) pane.append(el("p", "", `● ${say("terminal.pane.waiting")}`));
  pane.append(el("p", "ew-dim ew-gap", say("terminal.pane.policy")), el("p", "", modeName()));
  return pane;
}
function usageLine() {
  const used = Math.round((100 - sample.left) / 5);
  return `${say("everywhere.use.plan")}  ${"█".repeat(used)}${"░".repeat(20 - used)}  ${say("everywhere.use.left", { left: sample.left })}`;
}
/** The conversation, a list, the finder or a picker: whichever is open. */
function terminalBody() {
  const body = el("div", "ew-tui-conv");
  if (TU.find) body.append(...findLines());
  else if (TU.pick) body.append(el("p", "ew-b", TU.pick.title), ...listLines(TU.pick.items), el("p", "ew-dim", keysHint("terminal.keys.choose", "terminal.keys.close")));
  else if (TU.place === 1 && !TU.sub) body.append(...conversationLines(), promptLine());
  else {
    const title = TU.sub ? TU.sub.title : say(PLACES[TU.place - 1]);
    const items = placeItems();
    body.append(el("p", "ew-b", title), ...(items.length ? listLines(items) : [el("p", "ew-dim", say("terminal.empty.default"))]),
      el("p", "ew-dim", keysHint("everywhere.keys.open", "everywhere.keys.back")));
  }
  return body;
}
const keysHint = (...keys) => [say("terminal.keys.move"), ...keys.map((key) => say(key))].join(" · ");
function listLines(items) {
  return items.map(([label], index) => el("p", index === TU.sel ? "ew-tui-sel" : "", label));
}
function conversationLines() {
  const lines = [];
  for (const turn of sample.convs[TU.conv].turns) {
    if (turn.kind === "you") {
      const line = el("p");
      line.append(el("span", "ew-tui-you", say("everywhere.you")), ` ${words(turn)}`);
      lines.push(line);
    } else if (turn.kind === "answer") {
      const line = el("p");
      line.append(el("span", "ew-b", say("everywhere.agent")), ` ${words(turn)}`);
      lines.push(line);
    } else if (turn.kind === "step") lines.push(el("p", "ew-dim", `  ${words(turn)}`));
    else if (turn.kind === "sys") lines.push(el("p", "ew-tui-sys", words(turn)));
    else if (turn.kind === "ask" && turn.state === "wait")
      lines.push(el("p", "ew-tui-askl", say("everywhere.ask.command")), el("p", "ew-tui-code", `  ${turn.code}`), el("p", "ew-dim", say("terminal.composer.answer")));
  }
  return lines.slice(-18);
}
function promptLine() {
  const line = el("p");
  line.append(el("span", "ew-tui-you", "›"), ` ${TU.input}`, el("span", "ew-tui-cur", "▌"));
  if (!TU.input) line.append(el("span", "ew-dim", waitingAsk(TU.conv) ? "y / n / a / s" : say("terminal.composer.placeholder")));
  return line;
}
function findLines() {
  const q = TU.find.q.toLowerCase();
  TU.find.matches = finderItems().filter(([label]) => label.toLowerCase().includes(q)).slice(0, 10);
  const query = el("p");
  query.append(el("span", "ew-tui-you", "/"), ` ${TU.find.q}`, el("span", "ew-tui-cur", "▌"));
  const found = TU.find.matches.length ? listLines(TU.find.matches) : [el("p", "ew-dim", say("terminal.palette.none"))];
  return [el("p", "ew-b", say("terminal.palette.title")), query, ...found, el("p", "ew-dim", keysHint("terminal.keys.choose", "terminal.keys.close"))];
}
function finderItems() {
  const places = PLACES.map((key, index) => [say(key), () => goPlace(index + 1)]);
  const convs = Object.entries(sample.convs).map(([id, conv]) => [say(conv.title), () => openConv(id)]);
  return [...convs, ...places, ["/mode", () => pickMode()], ["/settings", () => openSettingsList()]];
}
function placeItems() {
  if (TU.sub) return TU.sub.items;
  const plain = (keys) => keys.map((key) => [say(key), null]);
  if (TU.place === 2) return Object.entries(sample.convs).map(([id, conv]) =>
    [`${waitingAsk(id) ? `● ${say("place.inbox.needs")}` : `✓ ${say("place.inbox.finished")}`}  ${say(conv.title)}`, () => openConv(id)]);
  if (TU.place === 3) return plain(["everywhere.auto.brief", "everywhere.auto.tidy", "everywhere.auto.compare"]);
  if (TU.place === 4) return plain(["everywhere.lib.memory", "everywhere.lib.documents", "everywhere.lib.made"]);
  return [[say("everywhere.custom.channels"), null], [say("everywhere.custom.settings"), openSettingsList]];
}
function openConv(id) {
  Object.assign(TU, { conv: id, place: 1, sub: null, sel: 0 });
}
function goPlace(place) {
  Object.assign(TU, { place, sub: null, sel: 0, esc: false });
}
function openSettingsList() {
  Object.assign(TU, { place: 5, sel: 0, sub: { title: say("menu.settingsShort"), items: PAGES.map((key) => [say(key), null]) } });
}
function pickMode() {
  TU.pick = { title: say("mode.question"), items: MODES.map(([id, key]) => [say(key), () => {
    sample.mode = id;
    sample.convs[TU.conv].turns.push({ kind: "sys", only: "terminal", text: say("everywhere.mode.set", { mode: say(key) }) });
  }]) };
  TU.sel = 0;
}
/** Lines that start with /: /mode, /settings, /go <place>, /usage; anything else is looked for. */
function command(text) {
  const [name, ...rest] = text.slice(1).split(" ");
  const note = (line) => sample.convs[TU.conv].turns.push({ kind: "sys", only: "terminal", text: line });
  if (name === "mode") return pickMode();
  if (name === "settings") return openSettingsList();
  if (name === "usage") return note(usageLine());
  if (name === "go") {
    const at = PLACES.findIndex((key) => say(key).toLowerCase().startsWith((rest[0] || "").toLowerCase()) && rest[0]);
    return at < 0 ? note(say("terminal.noPlace", { name: rest[0] || "" })) : goPlace(at + 1);
  }
  TU.find = { q: text.slice(1) };
  TU.sel = 0;
}
function submit() {
  const text = TU.input.trim();
  TU.input = "";
  if (!text) return;
  TU.last = text;
  if (text.startsWith("/")) return command(text);
  runFromTerminal(TU.conv, text);
}
function escape() {
  if (TU.find || TU.pick) TU.find = TU.pick = null;
  else if (TU.sub) TU.sub = null;
  else TU.esc = true;
}
/** Up, Down, Enter and Esc in any list; typing narrows the finder. */
function listKey(event, list) {
  const key = event.key;
  if (key === "ArrowDown") TU.sel = Math.min(list.length - 1, TU.sel + 1);
  else if (key === "ArrowUp") TU.sel = Math.max(0, TU.sel - 1);
  else if (key === "Enter") {
    const item = list[TU.sel];
    TU.find = TU.pick = null;
    item?.[1]?.();
  } else if (TU.find && key === "Backspace") TU.find.q = TU.find.q.slice(0, -1);
  else if (TU.find && key.length === 1) { TU.find.q += key; TU.sel = 0; }
}
function currentList() {
  if (TU.find) return TU.find.matches || [];
  if (TU.pick) return TU.pick.items;
  return TU.place !== 1 || TU.sub ? placeItems() : null;
}
function terminalKey(event) {
  const key = event.key, ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && key.toLowerCase() === "c") {
    if (stopWork()) sample.convs[TU.conv].turns.push({ kind: "sys", key: "everywhere.run.stopped" });
  } else if (ctrl && key.toLowerCase() === "k") { TU.find = { q: "" }; TU.sel = 0; }
  else if ((event.altKey || TU.esc) && /^[1-5]$/.test(key)) goPlace(Number(key));
  else if (key === "Escape") escape();
  else {
    TU.esc = false;
    const list = currentList();
    if (list) listKey(event, list);
    else if (waitingAsk(TU.conv) && !TU.input && /^[ynas]$/i.test(key)) return answer(TU.conv, key.toLowerCase());
    else if (key === "Enter") submit();
    else if (key === "ArrowUp") TU.input = TU.last;
    else if (key === "Backspace") TU.input = TU.input.slice(0, -1);
    else if (key.length === 1 && !ctrl) TU.input += key;
  }
  draw();
}
/* First in line for keys, so the window's own shortcuts (Shift+Tab, Ctrl K, /) never see the terminal's. */
window.addEventListener("keydown", (event) => {
  if (event.target?.id !== "ew-tui" || event.key === "Tab") return;
  event.stopImmediatePropagation();
  event.preventDefault();
  terminalKey(event);
}, true);

/* ---------- the phones and the tablet ---------- */
const PH = { place: "chat", conv: null, view: "list", trunk: null, draft: "", page: null, switches: { ask: true, aloud: false, sounds: true } };
const NAV = [["chat", "everywhere.phone.chat", "home"], ["inbox", "place.inbox", "inbox"], ["automations", "place.automations", "automations"],
  ["library", "place.library", "library"], ["more", "menu.settingsShort", "gear"]];
const go = (changes) => () => { Object.assign(PH, changes); draw(); };
const phoneConvs = () => Object.entries(sample.convs).filter(([, conv]) => !PH.trunk || conv.trunk === PH.trunk);
function deviceStage(kind) {
  const stage = el("div", "ew-stage");
  const device = el("div", `ew-dv ew-dv-${kind}`);
  device.dataset.device = kind;
  const status = el("div", "ew-dv-status");
  status.append(el("span", "", "9:41"), el("span", "", { iphone: "●●● 5G", android: "▾ ▴ 5G", tablet: "Wi-Fi 100%" }[kind]));
  device.append(status);
  if (kind === "tablet") device.append(tabletLayout());
  else {
    const screen = el("div", "ew-dv-screen");
    screen.append(...phoneScreen());
    device.append(trunkStrip("ew-dv-strip"), screen, phoneNav());
  }
  stage.append(device);
  return stage;
}
function trunkStrip(className) {
  const strip = el("div", className);
  for (const [id, glyph, key] of TRUNKS) {
    const face = tapper(`ew-dv-tr${PH.trunk === id ? " on" : ""}`, null, go({ trunk: PH.trunk === id ? null : id, view: "list", place: "chat" }), key);
    face.textContent = glyph;
    strip.append(face);
  }
  return strip;
}
function phoneNav() {
  const nav = el("nav", "ew-dv-nav");
  const inSettings = PH.view === "settings" || PH.view === "setpage";
  for (const [id, key, name] of NAV) {
    const on = id === "more" ? inSettings : PH.place === id && !inSettings;
    const button = tapper(on ? "on" : "", null, go(id === "more" ? { view: "settings" } : { place: id, view: "list" }));
    button.append(icon(name), worded("small", "", key));
    nav.append(button);
  }
  return nav;
}
function heading(key, back, extra) {
  const head = el("div", "ew-dv-h");
  if (back) head.append(Object.assign(tapper("ew-dv-back", null, go(back), "action.back"), { textContent: "‹" }));
  head.append(el("b", "", say(key)));
  if (extra) head.append(extra);
  return head;
}
function scroller(...children) {
  const box = el("div", "ew-dv-scroll");
  box.append(...children);
  return box;
}
/** What the phone shows: a list, a conversation, Talk live, usage, or Settings. */
function phoneScreen() {
  if (PH.view === "voice") return [voiceScreen()];
  if (PH.view === "usage") return [heading("everywhere.use.title", { view: "list" }), scroller(usageCard())];
  if (PH.view === "conv" && PH.conv) return conversationScreen(PH.conv);
  if (PH.view === "settings") return [heading("menu.settingsShort"), scroller(...PAGES.map((key) => row(say(key), go({ page: key, view: "setpage" }))))];
  if (PH.view === "setpage") return [heading(PH.page, { view: "settings" }), scroller(settingsCard())];
  if (PH.place !== "chat") return placeScreen();
  const ring = Object.assign(tapper("ew-dv-back", null, go({ view: "usage" }), "everywhere.phone.usage"), { textContent: "◔" });
  const list = phoneConvs().map(([id, conv]) => row(say(conv.title), go({ conv: id, view: "conv", place: "chat" }), say(conv.when), Boolean(waitingAsk(id))));
  return [heading(PH.trunk ? TRUNKS.find(([id]) => id === PH.trunk)[2] : "rail.conversations", null, ring), scroller(...list)];
}
function row(label, handler, when, dot) {
  const button = tapper("ew-dv-row", null, handler);
  if (dot) button.append(el("i", "ew-dv-dot"));
  button.append(el("span", "", label));
  if (when) button.append(el("small", "", when));
  return button;
}
function placeScreen() {
  const opens = () => { const note = document.querySelector(".ew-dv-screen .ew-dv-hint"); if (note) note.hidden = false; };
  const items = {
    inbox: Object.keys(sample.convs).filter(waitingAsk).map((id) => row(`${say("place.inbox.needs")} · ${say(sample.convs[id].title)}`, go({ conv: id, view: "conv", place: "chat" }))),
    automations: ["everywhere.auto.brief", "everywhere.auto.tidy", "everywhere.auto.compare"].map((key) => row(say(key), opens)),
    library: ["everywhere.lib.memory", "everywhere.lib.documents", "everywhere.lib.made"].map((key) => row(say(key), opens)),
  }[PH.place];
  const hint = worded("p", "ew-dv-hint", "everywhere.phone.opens");
  hint.hidden = true;
  const empty = worded("p", "ew-dim", "place.inbox.nothingWaits");
  return [heading(NAV.find(([id]) => id === PH.place)[1]), scroller(...(items.length ? items : [empty]), hint)];
}
function conversationScreen(id) {
  const conv = sample.convs[id];
  const bubbles = [];
  for (const turn of conv.turns) {
    if (turn.kind === "you") bubbles.push(el("div", "ew-dv-msg you", words(turn)));
    else if (turn.kind === "answer") bubbles.push(el("div", "ew-dv-msg", words(turn)));
    else if (turn.kind === "sys" && turn.only !== "terminal") bubbles.push(el("div", "ew-dv-msg sys", words(turn)));
    else if (turn.kind === "ask") bubbles.push(turn.state === "wait" ? askCard(id, turn) : el("div", "ew-dv-msg sys", say(turn.state === "yes" ? "everywhere.ask.approved" : "everywhere.ask.refused")));
  }
  if (busy() && conv.turns.at(-1)?.kind !== "answer") bubbles.push(el("div", "ew-dv-msg sys", say("everywhere.run.working")));
  return [heading(conv.title, { view: "list" }), scroller(...bubbles), composer(id)];
}
function askCard(id, turn) {
  const card = el("div", "ew-dv-ask");
  const buttons = el("div", "ew-dv-btns");
  buttons.append(tapper("ew-btn ew-btn-pri", "everywhere.ask.yes", () => answer(id, "y")), tapper("ew-btn", "everywhere.ask.no", () => answer(id, "n")));
  card.append(el("b", "", say("everywhere.ask.needs", { name: say("everywhere.agent") })), el("span", "", say("everywhere.ask.command")), el("code", "", turn.code), buttons);
  return card;
}
function composer(id) {
  const box = el("div", "ew-dv-comp");
  const input = el("input", "ew-dv-in");
  input.id = "ew-ph-in";
  input.value = PH.draft;
  input.placeholder = say("everywhere.phone.reply");
  input.setAttribute("aria-label", say("everywhere.phone.message"));
  input.addEventListener("input", () => { PH.draft = input.value; });
  const send = () => { const text = PH.draft.trim(); if (!text) return; PH.draft = ""; sendFromDevice(id, text); };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); send(); } });
  const mic = tapper("ew-dv-mic", null, go({ view: "voice" }), "everywhere.phone.talk");
  const up = tapper("ew-dv-send", null, send, "composer.send");
  mic.append(icon("mic"));
  up.append(icon("up"));
  box.append(input, mic, up);
  return box;
}
function voiceScreen() {
  const box = el("div", "ew-dv-voice");
  box.append(el("div", "ew-dv-orb"), worded("p", "", "everywhere.voice.listening"), worded("small", "", "everywhere.voice.note"),
    tapper("ew-btn", "everywhere.voice.end", go({ view: PH.conv ? "conv" : "list" })));
  return box;
}
function usageCard() {
  const card = el("div", "ew-dv-use");
  const bar = el("div", "ew-dv-bar");
  const fill = el("i");
  fill.style.width = `${100 - sample.left}%`;
  bar.append(fill);
  card.append(el("b", "", say("everywhere.use.plan")), el("small", "", say("everywhere.use.left", { left: sample.left })), bar, el("small", "ew-dim", say("everywhere.use.measured")));
  return card;
}
/** A page of the phone's Settings: sample switches that change nothing outside the preview. */
function settingsCard() {
  const card = el("div", "ew-dv-card");
  card.append(el("b", "", say(PH.page)));
  for (const [id, key] of [["ask", "everywhere.set.ask"], ["aloud", "everywhere.set.aloud"], ["sounds", "everywhere.set.sounds"]]) {
    const label = el("label", "ew-dv-sw");
    const box = el("input", "sw");
    box.type = "checkbox";
    box.checked = PH.switches[id];
    box.addEventListener("change", () => { PH.switches[id] = box.checked; });
    label.append(el("span", "", say(key)), box);
    card.append(label);
  }
  return card;
}
function tabletLayout() {
  const layout = el("div", "ew-dv-tab");
  const side = el("div", "ew-dv-side");
  for (const [id, conv] of phoneConvs()) {
    const item = row(say(conv.title), go({ conv: id, view: "list" }));
    if ((PH.conv || "quotes") === id) item.classList.add("on");
    side.append(item);
  }
  const settings = row(say("menu.settingsShort"), go({ view: "settings" }));
  settings.prepend(icon("gear"));
  side.append(settings);
  const main = el("div", "ew-dv-main");
  main.append(...(PH.view === "list" || (PH.view === "conv" && PH.conv) ? conversationScreen(PH.conv || "quotes") : phoneScreen()));
  layout.append(trunkStrip("ew-dv-rail"), side, main);
  return layout;
}

