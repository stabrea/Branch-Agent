/**
 * The chat-app card: four switches, each off, "when needed" or on, for what a chat shows and
 * accepts while Branch works (typing and progress, commands, passing later messages to the task,
 * keeping code whole). It only reads and writes the saved switches; see
 * src/channels/chat-live-settings.ts for what each setting does. Its home is Settings › Chat apps & devices.
 */
import { api, ownerAtWindow } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const fields = { liveStatus: "chat-live-status", commands: "chat-live-commands", steering: "chat-live-steering", splitting: "chat-live-splitting" };
const say = (text) => { const line = $("chat-live-state"); if (line) line.textContent = text; };

/** The switches as last read or saved. */
let saved = null;

function show(live) {
  for (const [name, id] of Object.entries(fields)) if ($(id)) $(id).value = live?.[name] ?? "off";
}

async function load() {
  if (!$("chat-live-form") || !ownerAtWindow()) return; // household-followups: the chat apps are the owner's
  saved = (await api("channels")).live;
  show(saved);
}

/** DG-025: a switch is kept the moment it changes, as the sample saves; one that will not save goes back. */
async function save(name, id) {
  try {
    saved = (await api("channels/live", { [name]: $(id).value })).live;
    $(id).value = saved[name];
    say(t("settings.chat-live.saved"));
  } catch (error) {
    $(id).value = saved?.[name] ?? "off";
    say(t("settings.chat-live.failed", { reason: error instanceof Error ? error.message : String(error) }));
  }
}

for (const [name, id] of Object.entries(fields)) $(id)?.addEventListener("change", () => save(name, id));
$("chat-live-form")?.addEventListener("submit", (event) => event.preventDefault());
/* Settings that will not load leave the card showing "off", which is what a fresh install has. */
load().catch(() => {});
/* On a fresh window the key is not there yet, so the card loads again once the owner is in. */
const signedIn = document.getElementById("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) load().catch(() => {}); })
  .observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
/* household-followups: loaded again once the window is the owner's. */
document.addEventListener("branch-profile", (event) => { if (event.detail?.owner) load().catch(() => {}); });
