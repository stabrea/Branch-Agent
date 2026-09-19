/* Redesign phase 1: how much the assistant may do in this conversation, as one chip in the message
   box (the approved sample's mode picker). Ask first, Plan, Auto and Full access; a choice that cannot
   be made right now is shown greyed with the reason, never hidden. The server decides what a task may
   really do (src/conversation-mode.ts); this only picks and shows. A new conversation starts on Ask
   first; one that existed before keeps following the owner's setting until somebody picks here. */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";
import { popover } from "/popover.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const PATHS = {
  ask: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z",
  plan: "M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1",
  auto: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  full: "M6 11h12v9H6zM8 11V8a4 4 0 017.5-2",
  follow: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 110 4 2 2 0 010-4zM10 15a2 2 0 110 4 2 2 0 010-4z",
  chevron: "M6 9l6 6 6-6",
  check: "M5 12l5 5 9-10",
};
/** The owner's setting, said as the mode it amounts to, for a conversation that follows it. */
const PRESET_AS_MODE = { off: "full", "ask-before-changes": "ask", workspace: "auto" };
const ORDER = ["ask", "plan", "auto", "full"];
let state = null;
/* A new conversation's choice before it is sent: undefined until picked, null for "follow my setting". */
let pending;
let confirming = false;

function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mode-icon");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
const session = () => $("conversation")?.dataset.sessionId || null;
/** The mode in force: this conversation's own, the one a new conversation will start with, or none. */
const chosen = () => (session() ? state?.mode ?? null : pending !== undefined ? pending : state?.newConversation ?? null);

/* ---------- the chip ---------- */

/* mac7/outside-review: a conversation carrying on work that came from outside the window (a chat app,
   a trigger, a schedule, another program) asks before every change whatever is picked; this says why,
   and how to work without being asked. */
const OUTSIDE_FROM = { channel: "chat", trigger: "trigger", schedule: "schedule", mcp: "program", a2a: "program", acp: "program" };
const outsideNote = () => (state?.outside ? t("mode.outsideNote", { from: t(`mode.outside.${OUTSIDE_FROM[state.outside] ?? "program"}`) }) : null);

function paintChip() {
  const chip = $("mode-chip");
  if (!chip || !state) return;
  const mode = chosen();
  const set = mode ?? PRESET_AS_MODE[state.following.preset] ?? null;
  /* Work from outside is never more than Ask first here (Plan is stricter still), so the chip says that. */
  const shown = state.outside && set !== "plan" ? "ask" : set;
  const label = shown ? t(`mode.${shown}`) : t("mode.yourRules");
  chip.replaceChildren(icon(state.locked ? "ask" : shown ?? "follow"), el("span", state.locked ? t("mode.lockdown") : label, "mode-label"), icon("chevron"));
  chip.dataset.mode = shown ?? "custom";
  chip.dataset.following = String(mode === null);
  chip.dataset.locked = String(state.locked);
  chip.dataset.outside = String(Boolean(state.outside));
  const words = mode === null ? t("mode.followingChip", { setting: state.following.label }) : label;
  chip.setAttribute("aria-label", `${t("mode.question")} ${state.locked ? t("mode.lockdown") : words}`);
  chip.title = state.locked ? t("mode.lockedNote") : outsideNote() ?? words;
}

/* ---------- the menu ---------- */

function choiceItem(choice, mode) {
  const item = el("button", undefined, "mode-item");
  item.type = "button";
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", String(mode === choice.mode));
  item.dataset.mode = choice.mode;
  const words = el("span", undefined, "mode-words");
  words.append(el("b", t(`mode.${choice.mode}`)), el("small", choice.available ? t(`mode.${choice.mode}.note`) : choice.why));
  item.append(icon(choice.mode), words, mode === choice.mode ? icon("check") : el("span"));
  if (!choice.available) {
    item.setAttribute("aria-disabled", "true");
    item.title = choice.why;
  } else item.addEventListener("click", () => void pick(choice.mode));
  return item;
}
function followItem(mode) {
  const item = el("button", undefined, "mode-item mode-follow");
  item.type = "button";
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", String(mode === null));
  const words = el("span", undefined, "mode-words");
  words.append(el("b", t("mode.follow")), el("small", t("mode.followNote", { setting: state.following.label })));
  item.append(icon("follow"), words, mode === null ? icon("check") : el("span"));
  item.addEventListener("click", () => void pick(null));
  return item;
}
function confirmFull(menu) {
  const box = el("div", undefined, "mode-confirm");
  box.setAttribute("role", "group");
  box.append(el("p", t("mode.fullWarning")));
  const yes = el("button", t("mode.fullYes"), "mode-danger");
  yes.type = "button";
  yes.addEventListener("click", () => { confirming = false; void pick("full", true); });
  const no = el("button", t("mode.cancel"), "quiet-button");
  no.type = "button";
  no.addEventListener("click", () => { confirming = false; paintMenu(menu); menu.querySelector(".mode-item")?.focus(); });
  box.append(yes, no);
  menu.replaceChildren(el("p", t("mode.full"), "mode-heading"), box);
  yes.focus();
}
function paintMenu(menu = $("mode-menu")) {
  if (!state) return;
  if (confirming) return confirmFull(menu);
  const mode = chosen();
  menu.replaceChildren(el("p", t("mode.question"), "mode-heading"));
  for (const id of ORDER) menu.append(choiceItem(state.choices.find((choice) => choice.mode === id), mode));
  menu.append(el("hr"), followItem(mode));
  if (state.locked) menu.append(el("p", t("mode.lockedNote"), "mode-note"));
  else if (state.outside) menu.append(el("p", outsideNote(), "mode-note mode-outside"));
  else if (mode === null) menu.append(el("p", t("mode.followingNote", { setting: state.following.label }), "mode-note"));
}
/** Arrows move between the choices that can be made; Home and End go to either end. */
function keys(event) {
  const items = [...$("mode-menu").querySelectorAll(".mode-item:not([aria-disabled='true']), .mode-confirm button")];
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (to === undefined || !items.length) return;
  event.preventDefault();
  items[(to + items.length) % items.length].focus();
}

/* ---------- choosing ---------- */

async function pick(mode, sure = false) {
  if (mode === "full" && !sure) { confirming = true; paintMenu(); return; }
  menuControl.close();
  if (!session()) {
    pending = mode;
    paintChip();
    toast(mode ? t("mode.pickedNew", { mode: t(`mode.${mode}`) }) : t("mode.followingNow", { setting: state.following.label }));
    return;
  }
  try {
    state = await api("conversation-mode", { sessionId: session(), mode });
    paintChip();
    toast(mode ? t("mode.picked", { mode: t(`mode.${mode}`) }) : t("mode.followingNow", { setting: state.following.label }));
  } catch (error) { toast(error.message); }
}
const ready = () => $("workspace")?.hidden === false && Boolean(sessionStorage.getItem("branch-token"));
export async function refreshMode() {
  if (!ready()) return;
  const here = session(), before = JSON.stringify(state);
  try { state = await api("conversation-mode" + (here ? `?sessionId=${encodeURIComponent(here)}` : "")); }
  catch { return; }
  if (!here && pending && state.choices.find((choice) => choice.mode === pending)?.available === false) pending = undefined;
  paintChip();
  paintDefault();
  /* mac7/ci-flakes-2: this runs on every redraw of the Lockdown switch, which the window's refresh does every
     3 s. Redrawing an open menu each time threw away the keyboard's place in it (arrows then did nothing), so
     it is redrawn only when something changed, and the keyboard stays on the same choice. */
  if (menuControl.isOpen() && JSON.stringify(state) !== before) repaintMenu();
}
function repaintMenu() {
  const menu = $("mode-menu"), items = () => [...menu.querySelectorAll(".mode-item")];
  const at = items().indexOf(document.activeElement);
  paintMenu(menu);
  if (at >= 0) items()[at]?.focus();
}

/* ---------- the owner's default, under When to check with me ---------- */

function paintDefault() {
  const select = $("mode-new-conversation");
  if (!select || !state) return;
  select.value = state.settings?.newConversation ?? "ask";
  select.disabled = !state.owner;
}
$("mode-new-conversation")?.addEventListener("change", async (event) => {
  try {
    await api("conversation-mode/settings", { newConversation: event.target.value });
    toast(t(event.target.value === "ask" ? "mode.setting.savedAsk" : "mode.setting.savedFollow"));
    await refreshMode();
  } catch (error) { toast(error.message); }
});

const menuControl = popover($("mode-chip"), $("mode-menu"), {
  onOpen: (menu) => paintMenu(menu),
  afterOpen: (menu) => (menu.querySelector(".mode-item[aria-checked='true']:not([aria-disabled='true'])") ?? menu.querySelector(".mode-item:not([aria-disabled='true'])"))?.focus(),
  onClose: () => { confirming = false; },
});
$("mode-menu").addEventListener("keydown", keys);
new MutationObserver(() => { if (!session()) pending = undefined; void refreshMode(); })
  .observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
document.addEventListener("branch-profile", () => void refreshMode());
document.addEventListener("branch-language", () => paintChip());
/* Lockdown can change from its switch at any time; the switch redraws itself when it does. */
const lockSwitch = $("lockdown-panel");
if (lockSwitch) new MutationObserver(() => void refreshMode()).observe(lockSwitch, { childList: true });
/* Nothing is asked before the window is unlocked. */
new MutationObserver(() => void refreshMode()).observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
/* app.js sends this with the message that starts a conversation; null means "follow my setting". */
globalThis.branchConversationMode = { refresh: refreshMode, pending: () => (session() || !state ? null : chosen()) };
void refreshMode();
