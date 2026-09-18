/**
 * mac7/wake-pins: the card for a word that starts a turn. It holds the switch, the word, how sure
 * the spotter must be, and — in the computer's own words — what this machine would really use to
 * spot it. Nothing here opens a microphone: the card only reads and writes the setting, and says
 * plainly when this computer has nothing that can spot a word without sending sound away.
 * Its home is Settings, Voice. See src/voice-wake.ts.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (text) => { const line = $("wake-word-state"); if (line) line.textContent = text; };

function show(state) {
  if (!$("wake-word-form")) return;
  $("wake-word-mode").value = state?.settings?.mode ?? "off";
  $("wake-word-word").value = state?.settings?.word ?? "";
  $("wake-word-sureness").value = state?.settings?.sureness ?? 80;
  // What this computer would really do, said whether the switch is on or off, because it is the
  // one thing that decides whether turning it on can work at all.
  $("wake-word-how").textContent = state?.spotter?.how ?? "";
  const blocked = state?.spotter?.available === false;
  $("wake-word-how").classList.toggle("warn", blocked);
  $("wake-word-refusal").textContent = state?.refusal ?? "";
}

async function load() {
  const signedIn = document.getElementById("workspace");
  if (!$("wake-word-form") || !signedIn || signedIn.hidden) return;
  show(await api("voice/wake"));
}

async function save(event) {
  event.preventDefault();
  try {
    const answer = await api("voice/wake", {
      mode: $("wake-word-mode").value,
      word: $("wake-word-word").value.trim(),
      sureness: Number($("wake-word-sureness").value) || 80,
    });
    show(answer.state);
    say(t("settings.wake-word.saved"));
  } catch (error) {
    say(t("settings.wake-word.failed", { reason: error instanceof Error ? error.message : String(error) }));
  }
}

$("wake-word-form")?.addEventListener("submit", save);
/* A fresh window shows the safe state — off, no word — before anything is asked for. */
show({ settings: { mode: "off", word: "", sureness: 80 }, spotter: { how: "", available: true }, refusal: "" });
load().catch(() => {});
const workspace = document.getElementById("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) load().catch(() => {}); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
