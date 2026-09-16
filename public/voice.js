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
    console.error("Voice recording init failed:", e);
    return false;
  }
}

/**
 * Start recording audio from the microphone.
 */
function startVoiceRecording() {
  if (!mediaRecorder) return false;
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
        authorization: "Bearer " + token,
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
        authorization: "Bearer " + token,
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
      headers: { authorization: "Bearer " + token },
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
        authorization: "Bearer " + token,
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

/**
 * Populate the voice selection dropdown with available voices.
 */
function populateVoices() {
  if (!('speechSynthesis' in window)) return;

  const voiceSelectEl = $("voice-select");
  if (!voiceSelectEl) return;

  const voices = speechSynthesis.getVoices();
  voiceSelectEl.replaceChildren(
    ...voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      return option;
    }),
  );
}

// Initialize when voices are loaded
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
}
