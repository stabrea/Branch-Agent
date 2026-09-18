/**
 * mac7/live-voice: the card for speaking and seeing the words. It holds the switch, how long a
 * quiet room ends a phrase, and — in the computer's own words — what this machine would really use
 * to write the words out, or which program to install when it has none.
 *
 * The one thing this card must say before anything else, and says above the switch rather than
 * below it: **while dictation is listening, the microphone stays open**. That is the feature, and
 * it is the one place this differs from the word that starts a turn, which lets go of the
 * microphone every window. Nobody should be able to switch this on without having read that.
 *
 * Nothing here opens a microphone. The card reads and writes the setting, and the line saying
 * whether the microphone is open this moment comes from the app — from the speech program's own
 * liveness — rather than from the switch, so the card cannot read as listening when it is not.
 * Its home is Settings, Voice. See src/voice-dictation.ts and src/voice-dictation-run.ts.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (text) => { const line = $("dictation-state"); if (line) line.textContent = text; };

function show(state) {
  if (!$("dictation-form")) return;
  // Somebody else on this computer is told dictation is the owner's and shown nothing else at all.
  const mine = state?.isOwner !== false;
  $("dictation-fields").hidden = !mine;
  $("dictation-mode").value = state?.settings?.mode ?? "off";
  $("dictation-silence").value = state?.settings?.silenceSeconds ?? 4;
  // What this computer would really do, said whether the switch is on or off, because it is the
  // one thing that decides whether turning it on can work at all. Taken from the answer rather
  // than written here, so the card cannot drift from what src/voice-dictation.ts actually says.
  $("dictation-how").textContent = state?.engine?.how ?? "";
  const blocked = state?.canDictate === false;
  $("dictation-how").classList.toggle("warn", blocked);
  // Whether the microphone is open this moment, read from the listener itself and never guessed.
  const line = $("dictation-open");
  line.textContent = !mine ? "" : blocked ? t("settings.dictation.cannot")
    : state?.open ? t("settings.dictation.open") : t("settings.dictation.closed");
  line.classList.toggle("warn", Boolean(state?.open) || blocked);
  $("dictation-refusal").textContent = state?.refusal ?? "";
}

async function load() {
  const signedIn = document.getElementById("workspace");
  if (!$("dictation-form") || !signedIn || signedIn.hidden) return;
  show(await api("voice/dictation"));
}

async function save(event) {
  event.preventDefault();
  try {
    const answer = await api("voice/dictation", {
      mode: $("dictation-mode").value,
      silenceSeconds: Number($("dictation-silence").value) || 4,
    });
    show(answer.state);
    say(t("settings.dictation.saved"));
  } catch (error) {
    say(t("settings.dictation.failed", { reason: error instanceof Error ? error.message : String(error) }));
  }
}

$("dictation-form")?.addEventListener("submit", save);
/* A fresh window shows the safe state — off, microphone closed — before anything is asked for. */
show({ settings: { mode: "off", silenceSeconds: 4 }, engine: { how: "", available: true },
  canDictate: true, open: false, refusal: "", isOwner: true });
load().catch(() => {});
const workspace = document.getElementById("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) load().catch(() => {}); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
