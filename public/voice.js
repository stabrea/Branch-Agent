var $ = (id) => document.getElementById(id);
// app.js keeps its token to itself (it is a module), so this classic script reads the saved one.
var voiceToken = () => sessionStorage.getItem("branch-token") || "";
// Filled in from /api/voice/voices: the words this kind of computer uses for its microphone switch.
var microphoneHelp = "The microphone is not available. Allow it for Branch Agent in Windows settings and try again.";
/**
 * Voice input and output for the web UI.
 * Handles microphone recording, transcription, and text-to-speech playback.
 */

let audioContext = null;
let mediaRecorder = null;
let recordingChunks = [];
let isRecording = false;
let currentAudio = null;

/**
 * Initialize voice recording. Returns true if the browser supports it.
 */
async function initVoiceRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("MediaRecorder not supported");
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = (event) => {
      recordingChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordingChunks, { type: "audio/webm" });
      recordingChunks = [];
      isRecording = false;
      await transcribeAudio(blob);
    };

    return true;
  } catch (e) {
    console.warn("Voice recording is not available:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Start recording audio from the microphone.
 */
async function startVoiceRecording() {
  // The microphone is asked for on the first press, never when the app opens.
  if (!mediaRecorder && !(await initVoiceRecording())) {
    const toastEl = $("toast");
    toastEl.textContent = microphoneHelp;
    toastEl.hidden = false;
    setTimeout(() => { toastEl.hidden = true; }, 4000);
    return false;
  }
  if (isRecording) return true;
  recordingChunks = [];
  mediaRecorder.start();
  isRecording = true;
  return true;
}

/**
 * Stop recording and transcribe the audio.
 */
function stopVoiceRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
}

/**
 * Send recorded audio to the server for transcription.
 */
async function transcribeAudio(blob) {
  const promptInput = $("prompt");
  const toastEl = $("toast");
  try {
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: {
        authorization: "Bearer " + voiceToken(),
      },
      body: blob,
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `Transcription failed: ${response.status}`);
    }

    const { text } = await response.json();
    promptInput.value = text;
    promptInput.focus();
  } catch (e) {
    toastEl.textContent = "Transcription failed: " + (e instanceof Error ? e.message : String(e));
    toastEl.hidden = false;
    setTimeout(() => {
      toastEl.hidden = true;
    }, 6000);
  }
}

/**
 * Play text as speech using browser's speechSynthesis or the provider's TTS.
 */
async function speakText(text, useProvider = false) {
  if (useProvider) {
    await speakWithProvider(text);
  } else {
    speakWithBrowserSynthesis(text);
  }
}

/**
 * Speak using the browser's built-in Web Speech API (speechSynthesis).
 */
function speakWithBrowserSynthesis(text) {
  if (!('speechSynthesis' in window)) {
    console.warn("Speech synthesis not supported");
    return;
  }

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);

  // Get voice settings from the UI or use defaults
  const voiceIdEl = $("voice-select");
  if (voiceIdEl) {
    const voiceId = voiceIdEl.value;
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.name === voiceId) || voices[0];
    if (voice) utterance.voice = voice;
  }

  const rateEl = $("speech-rate");
  if (rateEl) {
    utterance.rate = parseFloat(rateEl.value) || 1;
  }

  speechSynthesis.speak(utterance);
}

/**
 * Speak using the configured provider's TTS endpoint.
 */
async function speakWithProvider(text) {
  const toastEl = $("toast");
  try {
    const response = await fetch("/api/voice/speak", {
      method: "POST",
      headers: {
        authorization: "Bearer " + voiceToken(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Speech generation failed: ${response.status}`);
    }

    const blob = await response.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;
    await audio.play();
  } catch (e) {
    toastEl.textContent = "Speech failed: " + (e instanceof Error ? e.message : String(e));
    toastEl.hidden = false;
    setTimeout(() => {
      toastEl.hidden = true;
    }, 6000);
  }
}

/**
 * Stop any currently playing speech.
 */
function stopSpeaking() {
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }
}

/**
 * Load voice settings from the server.
 */
async function loadVoiceSettings() {
  try {
    const response = await fetch("/api/voice/settings", {
      headers: { authorization: "Bearer " + voiceToken() },
    });
    if (!response.ok) return;

    const settings = await response.json();
    const autoReadEl = $("auto-read-aloud");
    const voiceSelectEl = $("voice-select");
    const rateEl = $("speech-rate");
    const providerVoiceEl = $("use-provider-voice");

    if (autoReadEl) autoReadEl.checked = settings.autoReadAloud;
    if (voiceSelectEl) voiceSelectEl.value = settings.voiceId;
    if (rateEl) rateEl.value = settings.speechRate;
    if (providerVoiceEl) providerVoiceEl.checked = settings.useProviderVoice;
  } catch (e) {
    console.error("Failed to load voice settings:", e);
  }
}

/**
 * Save voice settings to the server.
 */
async function saveVoiceSettings() {
  try {
    const autoReadEl = $("auto-read-aloud");
    const voiceSelectEl = $("voice-select");
    const rateEl = $("speech-rate");
    const providerVoiceEl = $("use-provider-voice");

    const settings = {
      autoReadAloud: autoReadEl?.checked ?? false,
      voiceId: voiceSelectEl?.value ?? "default",
      speechRate: parseFloat(rateEl?.value ?? "1"),
      useProviderVoice: providerVoiceEl?.checked ?? false,
    };

    const response = await fetch("/api/voice/settings", {
      method: "POST",
      headers: {
        authorization: "Bearer " + voiceToken(),
        "content-type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      throw new Error("Failed to save settings");
    }
  } catch (e) {
    console.error("Failed to save voice settings:", e);
  }
}

/** The voices already on this computer (Windows, `say` on a Mac, espeak-ng on Linux), asked for when the list is opened. */
var systemVoiceNames = [];
var systemVoicesAsked = false;

async function voiceRequest(path) {
  const response = await fetch(path, { headers: { authorization: "Bearer " + voiceToken() } });
  return response.ok ? response.json() : null;
}

/** The words this kind of computer uses; asking for the plan starts no program. */
async function loadSystemVoiceWords() {
  try {
    const plan = await voiceRequest("/api/voice/plan");
    const words = plan && plan.systemVoice;
    if (!words) return;
    if (typeof words.microphoneHelp === "string") microphoneHelp = words.microphoneHelp;
    const route = document.querySelector('#voice-tts-route option[value="windows"]');
    if (route && typeof words.label === "string") route.textContent = words.label;
  } catch (e) {
    console.warn("The voice wording could not be read:", e instanceof Error ? e.message : e);
  }
}

async function loadSystemVoices() {
  if (systemVoicesAsked) return;
  systemVoicesAsked = true;
  try {
    const data = await voiceRequest("/api/voice/voices");
    if (!data) { systemVoicesAsked = false; return; }
    systemVoiceNames = Array.isArray(data.system) ? data.system : Array.isArray(data.windows) ? data.windows : [];
    populateVoices();
  } catch (e) {
    systemVoicesAsked = false;
    console.warn("The computer's own voices could not be listed:", e instanceof Error ? e.message : e);
  }
}

function voiceOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

/**
 * Populate the voice selection dropdown: the computer's own voices first, then the browser's.
 */
function populateVoices() {
  const voiceSelectEl = $("voice-select");
  if (!voiceSelectEl) return;
  const chosen = voiceSelectEl.value;
  const groups = [voiceOption("default", "Default")];
  if (systemVoiceNames.length) {
    const own = document.createElement("optgroup");
    own.label = "Your computer's own voices";
    own.append(...systemVoiceNames.map((name) => voiceOption(name, name)));
    groups.push(own);
  }
  const listed = new Set(systemVoiceNames);
  const browser = 'speechSynthesis' in window ? speechSynthesis.getVoices().filter((voice) => !listed.has(voice.name)) : [];
  if (browser.length) {
    const inBrowser = document.createElement("optgroup");
    inBrowser.label = "Voices in this window";
    inBrowser.append(...browser.map((voice) => voiceOption(voice.name, `${voice.name} (${voice.lang})`)));
    groups.push(inBrowser);
  }
  voiceSelectEl.replaceChildren(...groups);
  if (chosen && [...voiceSelectEl.options].some((option) => option.value === chosen)) voiceSelectEl.value = chosen;
}

// Initialize when voices are loaded
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();
if (sessionStorage.getItem("branch-token")) void loadSystemVoiceWords();
else addEventListener("load", () => void loadSystemVoiceWords(), { once: true });
// The computer is asked for its voices only when the owner opens the list, never when the page opens.
for (const id of ["voice-select", "voice-tts-route"]) {
  $(id)?.addEventListener("focus", () => { void loadSystemVoiceWords(); void loadSystemVoices(); });
}
