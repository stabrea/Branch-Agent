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
/* DG-025: saved as you go, as in the approved sample: each change is kept the moment it is made, with no Save button. */
$("dictation-form")?.addEventListener("change", save);
/* A fresh window shows the safe state — off, microphone closed — before anything is asked for. */
show({ settings: { mode: "off", silenceSeconds: 4 }, engine: { how: "", available: true },
  canDictate: true, open: false, refusal: "", isOwner: true });
load().catch(() => {});
const workspace = document.getElementById("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) load().catch(() => {}); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });


/* ---------- the Dictate control: the only thing anywhere that opens a microphone ---------- */

/**
 * Pressing Dictate is the one and only way the microphone is ever opened. No setting opens one, no
 * settings file opens one, no preset opens one, and unlocking Branch does not reopen one. While it
 * is on, the words arrive and are written into the message box — greyed while the program is still
 * unsure of them, ordinary once a quiet room has settled them. It never sends: you press Send.
 *
 * The words come back by asking, three times a second, while the microphone is open and not
 * otherwise. They are screen state at both ends: Branch holds them in memory for the phrase being
 * spoken and nothing else, and nothing here writes them anywhere but the box you are looking at.
 */
const ask = (id) => document.getElementById(id);
const box = () => ask("prompt");
/** Where the box was before dictation started, so the words are added to what you typed, not over it. */
let typed = "";
let asking = null;
/**
 * merge-queue review: the phrase already added to the box. The app keeps a settled phrase until the
 * next press, and a question already on its way when the microphone closed answers with it again,
 * so without this the words were written in twice.
 */
let settledAlready = null;
/** phase2/rooms: what the box held when the microphone opened, so the bar's ✕ can put it back. */
let startedWith = "";

const line = (text, open) => {
  const note = ask("voice-dictate-status");
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
  note.classList.toggle("warn", Boolean(open));
};

/** The words into the box. Provisional words are greyed until a quiet room settles them. */
/** True while the ✕ is throwing the words away: nothing of them is written into the box any more. */
let discarding = false;
function write(state) {
  const field = box();
  if (!field || discarding) return;
  const said = state?.words ?? "";
  if (state?.settled && said && said === settledAlready) return;
  field.value = typed ? (said ? `${typed} ${said}` : typed) : said;
  field.classList.toggle("dictating", Boolean(state?.open) && !state?.settled);
  if (state?.settled && said) { typed = field.value; settledAlready = said; } // the phrase is yours now; the next one follows it
}

/**
 * ci-flakes-3: which press the questions belong to. A question sent while the microphone was open can
 * answer after it closed; its words and its "open" then came back over the ✕ that had just put the box
 * back, so it is dropped once another press has happened.
 */
let round = 0;
async function collect() {
  const mine = round;
  const state = await api("voice/dictation").catch(() => null);
  if (!state || mine !== round) return;
  write(state);
  ask("voice-dictate").setAttribute("aria-pressed", String(Boolean(state.open)));
  // The line is on for exactly as long as the microphone is, and it is driven by the app's answer
  // rather than by what was last pressed, so it cannot say one thing while the microphone does
  // another.
  line(state.open ? t("settings.dictation.open") : "", state.open);
  if (!state.open) { stopAsking(); }
}

function stopAsking() {
  if (asking) { clearInterval(asking); asking = null; }
}

async function press() {
  const button = ask("voice-dictate");
  const on = button.getAttribute("aria-pressed") !== "true";
  round += 1;
  if (!on) stopAsking();
  if (on) { typed = (box()?.value ?? "").trim(); settledAlready = null; startedWith = box()?.value ?? ""; }
  try {
    const answer = await api("voice/dictation/listen", { on });
    if (answer.refusal) { line(answer.refusal, false); stopAsking(); return; }
    button.setAttribute("aria-pressed", String(Boolean(answer.open)));
    line(answer.open ? t("settings.dictation.open") : "", answer.open);
    if (answer.open) { stopAsking(); asking = setInterval(() => void collect(), 300); }
    else { stopAsking(); await collect(); }
  } catch (error) {
    stopAsking();
    line(error instanceof Error ? error.message : String(error), false);
  }
}

/**
 * Whether the control is offered at all. "On" means always; "when needed" means once a conversation
 * is open on the screen, which is something this window really knows — unlike the wake word, whose
 * "when needed" is unwired and says so. Neither ever opens a microphone: only a press does.
 */
export async function refreshDictateButton() {
  const button = ask("voice-dictate");
  if (!button) return;
  const state = await api("voice/dictation").catch(() => null);
  const talking = (ask("conversation")?.children.length ?? 0) > 0;
  const offered = state?.canDictate === true && !state?.refusal
    && (state.mode === "on" || (state.mode === "when-needed" && talking));
  button.hidden = !offered;
  if (!offered) { stopAsking(); line("", false); }
}

ask("voice-dictate")?.addEventListener("click", () => void press());
/**
 * phase2/rooms: the dictation bar's two ways to stop (public/voice-bar.js). Keep: exactly what the
 * Dictate button does. Throw away: the same, then the box goes back to what it held before.
 */
globalThis.branchDictation = {
  listening: () => ask("voice-dictate")?.getAttribute("aria-pressed") === "true",
  async stop(keep) {
    /* Closing the microphone asks one last time, and that answer arrives while this is still running:
       its words must not land in the box the ✕ is about to put back (it showed them for a moment). */
    discarding = !keep;
    const field = box();
    if (!keep && field) { field.value = startedWith; typed = startedWith.trim(); }
    try {
      if (ask("voice-dictate")?.getAttribute("aria-pressed") === "true") await press();
    } finally { discarding = false; }
    if (keep || !field) return;
    field.value = startedWith;
    field.classList.remove("dictating");
    typed = startedWith.trim();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  },
};
/* Escape stops it, as it does everything else that is open: the microphone closes with it. */
box()?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ask("voice-dictate")?.getAttribute("aria-pressed") === "true") void press();
});
void refreshDictateButton();
if (workspace) new MutationObserver(() => { if (!workspace.hidden) void refreshDictateButton(); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
/* A conversation opening or closing is what "when needed" means, so the control follows it. */
const talk = document.getElementById("conversation");
if (talk) new MutationObserver(() => void refreshDictateButton()).observe(talk, { childList: true });
