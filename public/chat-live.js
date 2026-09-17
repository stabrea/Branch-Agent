/**
 * The chat-app card: four switches, each off, "when needed" or on, for what a chat shows and
 * accepts while Branch works (typing and progress, commands, passing later messages to the task,
 * keeping code whole). It only reads and writes the saved switches; see
 * src/channels/chat-live-settings.ts for what each setting does. Its home is Customize, Chat apps.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const fields = { liveStatus: "chat-live-status", commands: "chat-live-commands", steering: "chat-live-steering", splitting: "chat-live-splitting" };
const say = (text) => { const line = $("chat-live-state"); if (line) line.textContent = text; };

function show(live) {
  for (const [name, id] of Object.entries(fields)) if ($(id)) $(id).value = live?.[name] ?? "off";
}

async function load() {
  if (!$("chat-live-form")) return;
  show((await api("channels")).live);
}

async function save(event) {
  event.preventDefault();
  const change = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, $(id).value]));
  try {
    show((await api("channels/live", change)).live);
    say(t("settings.chat-live.saved"));
  } catch (error) {
    say(t("settings.chat-live.failed", { reason: error instanceof Error ? error.message : String(error) }));
  }
}

$("chat-live-form")?.addEventListener("submit", save);
/* Settings that will not load leave the card showing "off", which is what a fresh install has. */
load().catch(() => {});
