/**
 * DG-047: Settings › Voice › Listening right now. One line saying what is listening this moment, read from the
 * listeners themselves (the word that starts a turn and dictation, src/voice-wake.ts and src/voice-dictation.ts)
 * and never guessed from a switch: listening for your word, the microphone open for dictation, nothing, or a
 * computer that cannot listen at all. It changes nothing. It asks again whenever the card comes into sight, and
 * every few seconds while it stays there.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const AGAIN_MS = 5000;
let last = null;

/** The words for the state of both listeners; exported for the test through the page. */
export function listeningWords(wake, dictation) {
  if (!wake && !dictation) return t("settings.voice-listening.unknown");
  if (wake?.listening) return t("settings.voice-listening.word", { word: wake.settings?.word ?? "" });
  if (dictation?.open) return t("settings.voice-listening.dictation");
  if (wake?.canListen === false && dictation?.canDictate === false) return t("settings.voice-listening.unavailable");
  return t("settings.voice-listening.none");
}

function show() {
  const line = $("voice-listening-now");
  if (!line) return;
  const words = last ? listeningWords(last.wake, last.dictation) : t("settings.voice-listening.none");
  if (line.textContent !== words) line.textContent = words;
  line.dataset.state = !last ? "none" : last.wake?.listening ? "word" : last.dictation?.open ? "dictation"
    : last.wake?.canListen === false && last.dictation?.canDictate === false ? "unavailable" : "none";
}

async function load() {
  const signedIn = $("workspace");
  if (!$("voice-listening-card") || !signedIn || signedIn.hidden) return;
  const [wake, dictation] = await Promise.all([api("voice/wake").catch(() => null), api("voice/dictation").catch(() => null)]);
  last = { wake, dictation };
  show();
}

/* Asked for only while the card is on the screen: a closed Settings window asks nothing. */
let timer = 0;
const card = $("voice-listening-card");
if (card && "IntersectionObserver" in globalThis) {
  new IntersectionObserver(([entry]) => {
    clearInterval(timer);
    if (!entry?.isIntersecting) return;
    load().catch(() => {});
    timer = setInterval(() => load().catch(() => {}), AGAIN_MS);
  }).observe(card);
}
document.addEventListener("branch-language", show);
show();
load().catch(() => {});
