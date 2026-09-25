/**
 * mac7/wake-pins: the card for a word that starts a turn. It holds the switch, the word, how sure
 * the spotter must be, and — in the computer's own words — what this machine would really use to
 * spot it. Nothing here opens a microphone: the card only reads and writes the setting, and says
 * plainly when this computer has nothing that can spot a word without sending sound away.
 * mac7/wake-mic: the card now also says, honestly, whether this computer can listen at all and
 * whether it is listening this moment. Both come from the app rather than from the switch, so the
 * card cannot read as though it were listening when it is not. Its home is Settings, Voice.
 * See src/voice-wake.ts.
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
  // mac7/wake-mic: what really opens the microphone here, then what really spots the word. Both
  // sentences are taken from the answer rather than written here, so the card cannot drift from
  // what src/voice-wake.ts actually says.
  $("wake-word-how").textContent = [state?.capture?.how, state?.spotter?.how].filter(Boolean).join(" ");
  const blocked = state?.canListen === false;
  $("wake-word-how").classList.toggle("warn", blocked);
  // Whether it is listening this moment, read from the listener itself and never guessed from the
  // switch: a computer that cannot listen says so instead.
  shown = state;
  sayListening();
  $("wake-word-refusal").textContent = state?.refusal ?? "";
}
/* NAS 703fb96: the line is written in words, so it is written again when the language changes (only the line, so
   nothing the owner is typing on the card is touched). */
let shown = null;
function sayListening() {
  const line = $("wake-word-listening");
  if (!line || !shown) return;
  const blocked = shown.canListen === false;
  line.textContent = blocked ? t("settings.wake-word.cannot")
    : shown.listening ? t("settings.wake-word.listening") : t("settings.wake-word.idle");
  line.classList.toggle("warn", blocked);
}
document.addEventListener("branch-language", sayListening);

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
/* DG-025: saved as you go, as in the approved sample: each change is kept the moment it is made, with no Save button. */
$("wake-word-form")?.addEventListener("change", save);
/* A fresh window shows the safe state — off, no word — before anything is asked for. */
show({ settings: { mode: "off", word: "", sureness: 80 }, spotter: { how: "", available: true },
  capture: { how: "", available: true }, canListen: true, listening: false, refusal: "" });
load().catch(() => {});
const workspace = document.getElementById("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) load().catch(() => {}); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
