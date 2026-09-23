/**
 * Talking to Branch and hearing it talk back. Hold the Talk button, speak, let go: what you said
 * is written out, sent as an ordinary message, and the answer is read aloud. Press Talk again to
 * cut it off. The four states this moves through are the same four the server knows about.
 */
import { formatNumber, t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const bearer = () => "Bearer " + (sessionStorage.getItem("branch-token") || "");
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: bearer(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
/** The page gives an element the id "toast", so only a real function is ever called. */
const say = (message) => (typeof globalThis.toast === "function" ? globalThis.toast(message) : console.warn(message));
const connected = () => Boolean(sessionStorage.getItem("branch-token"));

/* ---------- reading a reply aloud, wherever the voice comes from ---------- */

let playing = null;
/**
 * Reads text aloud through the server, which decides whether that is a voice from the internet or
 * the one that comes with Windows. If the server cannot, the browser's own voice has a go, so the
 * button never simply does nothing.
 */
globalThis.branchSpeak = async function branchSpeak(text) {
  globalThis.branchStopSpeaking();
  try {
    const response = await fetch("/api/voice/speak", {
      method: "POST", headers: { authorization: bearer(), "content-type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 4000) }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Reading aloud did not work");
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    playing = audio;
    await audio.play();
    return new Promise((done) => { audio.onended = done; audio.onerror = done; });
  } catch (error) {
    if ("speechSynthesis" in window) { globalThis.speakWithBrowserSynthesis?.(text); return; }
    say(error.message);
  }
};
globalThis.branchStopSpeaking = function branchStopSpeaking() {
  if (playing) { playing.pause(); playing = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
};

/* ---------- hold to talk ---------- */

const statusFor = {
  idle: "Hold the Talk button and speak",
  listening: "Listening… let go when you are done",
  thinking: "Working on your answer",
  speaking: "Reading the answer aloud — press Talk to stop",
};
let state = "idle";
let recorder = null;
let chunks = [];
let startedAt = 0;

function show(next) {
  state = next;
  const row = $("voice-talk-status");
  if (!row) return;
  row.textContent = statusFor[state];
  row.hidden = state === "idle";
  const button = $("voice-talk");
  if (button) button.textContent = state === "speaking" ? "Stop" : "Talk";
}

async function ready() {
  if (recorder) return true;
  if (!navigator.mediaDevices?.getUserMedia) { say("This browser cannot record sound."); return false; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => void finish();
    return true;
  } catch (error) {
    say("The microphone is not available. Allow it for Branch Agent in Windows settings and try again.");
    return false;
  }
}

let lastAnswer = "";
/** Bucket 17: what a spoken command does. Nothing is sent to the assistant. */
async function spokenCommand(command) {
  if (command === "stop") { globalThis.branchStopSpeaking?.(); return; }
  if (command === "repeat" && lastAnswer) { show("speaking"); await globalThis.branchSpeak(lastAnswer); return; }
  if (command === "slower" || command === "faster") {
    const response = await fetch("/api/voice/settings", { headers: { authorization: bearer() } });
    const current = await response.json();
    const speechRate = Math.min(2, Math.max(0.5, (current.speechRate ?? 1) + (command === "slower" ? -0.25 : 0.25)));
    await fetch("/api/voice/settings", {
      method: "POST", headers: { authorization: bearer(), "content-type": "application/json" }, body: JSON.stringify({ speechRate }),
    });
    say(`Speaking speed is now ${speechRate}.`);
  }
}
/** Sends the recording, puts the words in the box, runs them, and reads the answer aloud. */
async function finish() {
  const blob = new Blob(chunks, { type: "audio/webm" });
  chunks = [];
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  show("thinking");
  try {
    const response = await fetch(`/api/voice/transcribe?seconds=${seconds}`, {
      method: "POST", headers: { authorization: bearer(), "content-type": "audio/webm" }, body: blob,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "That recording could not be written out");
    if (!data.text?.trim()) throw new Error("Nothing was heard in that recording");
    // Bucket 17: "stop", "say that again", "slower", "faster" are commands, not messages.
    if (data.command) { await spokenCommand(data.command); return; }
    $("prompt").value = data.text;
    const answer = await globalThis.branchRunSpoken?.(data.text);
    if (typeof answer === "string" && answer.trim()) {
      lastAnswer = answer;
      show("speaking");
      await globalThis.branchSpeak(answer);
    }
  } catch (error) {
    say(error.message);
  } finally {
    show("idle");
  }
}

async function press() {
  if (state === "speaking") { globalThis.branchStopSpeaking(); show("idle"); return; }
  if (state !== "idle") return;
  if (!(await ready())) return;
  chunks = [];
  startedAt = Date.now();
  recorder.start();
  show("listening");
  // R17-S18: the longest recording the owner allows (public/comfort.js); unset, it runs until let go.
  const limit = globalThis.branchComfort?.maxRecordingSeconds?.();
  if (limit) { const started = startedAt; setTimeout(() => { if (startedAt === started) release(); }, limit * 1000); }
}
function release() {
  if (state !== "listening" || !recorder) return;
  recorder.stop();
}

function wireTalk() {
  const button = $("voice-talk");
  if (!button) return;
  button.addEventListener("pointerdown", (event) => { event.preventDefault(); void press(); });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointerleave", release);
  button.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") void press(); });
  button.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") release(); });
  show("idle");
}

/* ---------- the Voice settings screen ---------- */

const fields = [
  ["voice-keep-local", "keepAudioOnThisComputer", "checked"],
  ["voice-stt-route", "sttRoute", "value"],
  ["voice-tts-route", "ttsRoute", "value"],
  ["voice-language", "language", "value"],
  ["voice-local-exe", "localSpeechExecutable", "value"],
  ["voice-local-model", "localSpeechModel", "value"],
  ["voice-reply-audio", "replyWithVoiceOnChannels", "checked"],
  // Wave 8: the limits a live conversation runs under, and whether any of its sound is kept.
  ["voice-live-minutes", "liveMaxMinutes", "value"],
  ["voice-live-dollars", "liveMaxDollars", "value"],
  ["voice-live-vad", "liveVoiceDetection", "checked"],
  ["voice-live-record", "keepLiveRecordings", "checked"],
  ["voice-live-view", "liveView", "value"], // phase2/rooms: Talk live in its own view (public/voice-view.js)
];
/** The older settings on the same card, which public/voice.js fills in. They are kept as you go like the rest. */
const olderFields = [
  ["auto-read-aloud", "autoReadAloud", "checked"],
  ["voice-select", "voiceId", "value"],
  ["speech-rate", "speechRate", "value"],
  ["use-provider-voice", "useProviderVoice", "checked"],
];
/** These are numbers on the way back out; everything else on this form is text or a tick. */
const numberFields = new Set(["liveMaxMinutes", "liveMaxDollars", "speechRate"]);
/** A reason read from the server already ends in a full stop; the line adds its own. */
const clause = (words) => String(words ?? "").trim().replace(/\.+$/, "");

let shownPlan = null;
/** The lines under the card that follow from the settings: where sound goes, what it costs, what each route does. */
function showPlanLines(plan) {
  shownPlan = plan;
  $("voice-where").textContent = plan.whereAudioGoes;
  $("voice-prices").textContent = priceLine(plan.prices) + " " + plan.realtimeNote;
  $("voice-status").textContent = t("settings.voice.plan-line",
    { listen: clause(plan.speechToText.reason), speak: clause(plan.readAloud.reason) });
}
async function loadVoicePlan() {
  if (!$("voice-keep-local")) return;
  try {
    const plan = await request("/api/voice/plan");
    for (const [id, key, kind] of fields) {
      const node = $(id);
      if (node) node[kind] = plan.settings[key] ?? (kind === "checked" ? false : "");
    }
    showPlanLines(plan);
  } catch (error) {
    $("voice-status").textContent = error.message;
  }
}
/** A price in the chosen language's own way of writing numbers, to a tenth of a cent. */
const price = (each) => formatNumber(each, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
function priceLine(prices) {
  const minute = Object.entries(prices.perMinute)
    .map(([model, each]) => t("settings.voice.price-minute", { model, each: price(each) })).join(", ");
  const characters = Object.entries(prices.perThousandCharacters)
    .map(([model, each]) => t("settings.voice.price-characters", { model, each: price(each) })).join(", ");
  return t("settings.voice.prices", { date: prices.transcriptionPricedAt, minute, characters });
}

/** The words a person reads beside a control: its own label, in the language now chosen. */
const labelOf = (node) => (node.labels?.[0]?.textContent ?? node.id).replace(/\s+/g, " ").trim();
function valueOf(node, key, kind) {
  if (key === "speechRate") return Number.parseFloat(node.value) || 1;
  if (key === "voiceId") return node.value || "default";
  return numberFields.has(key) ? Number.parseFloat(node[kind]) : node[kind];
}
/**
 * DG-025: kept as you go, as in the approved sample, with no Save button. Only the setting that changed
 * is sent (the server keeps the rest), so a control this page has not filled in yet can never
 * overwrite what is saved. A refusal says why and puts that one control back as it is saved.
 */
async function keepOne(event) {
  const entry = [...fields, ...olderFields].find(([id]) => id === event.target?.id);
  if (!entry) return;
  const [, key, kind] = entry;
  const node = event.target;
  const label = labelOf(node);
  try {
    await request("/api/voice/settings", { [key]: valueOf(node, key, kind) });
    say(t("settings.voice.saved-one", { label }));
    showPlanLines(await request("/api/voice/plan"));
  } catch (error) {
    say(t("settings.voice.not-saved", { label, reason: clause(error.message) }));
    try {
      const saved = (await request("/api/voice/plan")).settings?.[key];
      if (saved !== undefined) node[kind] = saved;
    } catch { /* the line above has already said it was not kept */ }
  }
}

function wireVoiceSettings() {
  $("voice-settings-form")?.addEventListener("submit", (event) => event.preventDefault());
  $("voice-settings-form")?.addEventListener("change", (event) => void keepOne(event));
  document.addEventListener("branch-language", () => { if (shownPlan) showPlanLines(shownPlan); });
  $("voice-test-speak")?.addEventListener("click", () =>
    void globalThis.branchSpeak("This is how Branch Agent will read your replies aloud."));
  $("voice-test-record")?.addEventListener("click", async () => {
    if (state !== "idle") return;
    await press();
    setTimeout(release, 3000);
    say("Say something for three seconds; the words will appear in the message box.");
  });
  if (connected()) void loadVoicePlan();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
function start() {
  wireTalk();
  wireVoiceSettings();
}
/** app.js calls this once you have connected, which is the first moment settings can be read. */
const waiting = globalThis.branchVoiceReady;
globalThis.branchVoiceReady = () => { waiting?.(); void loadVoicePlan(); };
