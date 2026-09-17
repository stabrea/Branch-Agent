/**
 * A live conversation: you talk, it answers while you are still listening, and pressing the button
 * cuts it off mid-sentence the way you would cut off a person. The microphone stays open the whole
 * time, so the sound goes up as it is spoken rather than after you let go.
 *
 * The button only appears when the connection you are using can do this. On anything else, and
 * whenever you have asked for sound to stay on this computer, the ordinary Talk button is what
 * you get, and it says why.
 */
const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";
const say = (message) => (typeof globalThis.toast === "function" ? globalThis.toast(message) : console.warn(message));

/* ---------- the states, the same four the server knows about ---------- */

const statusFor = {
  idle: "Press Talk to start a live conversation",
  "listening-live": "Listening — talk whenever you like, and press Talk to stop",
  speaking: "Answering — press Talk to cut in",
  interrupted: "Stopping — carry on talking",
};
let state = "idle";
let socket = null;
let microphone = null;
let player = null;
let nextPlayAt = 0;

function show(next) {
  state = next;
  const row = $("voice-live-status");
  if (row) { row.textContent = statusFor[state]; row.hidden = state === "idle"; }
  const button = $("voice-live");
  if (button) button.textContent = state === "idle" ? "Talk live" : state === "speaking" ? "Cut in" : "Stop";
}

/* ---------- sound in: the microphone, turned into PCM16 as it is spoken ---------- */

/** Turns the browser's floating-point sound into the 16-bit whole numbers both services want. */
export function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}
/** The small program that runs beside the sound card and hands each block of sound back. */
const workletSource = `
class BranchMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("branch-mic", BranchMic);`;

async function openMicrophone(send) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" })));
  const node = new AudioWorkletNode(context, "branch-mic");
  node.port.onmessage = (event) => send(toPcm16(event.data).buffer);
  context.createMediaStreamSource(stream).connect(node);
  return { close: () => { stream.getTracks().forEach((track) => track.stop()); void context.close(); } };
}

/* ---------- sound out: each block played in the order it arrived ---------- */

/** Reads one block of sound off the socket: where it belongs in the order, then the sound itself. */
export function readAudioFrame(bytes) {
  const view = new DataView(bytes);
  return { sequence: view.getUint32(0), pcm16: new Int16Array(bytes.slice(4)) };
}
function play(pcm16) {
  player ??= new AudioContext({ sampleRate: 24000 });
  const buffer = player.createBuffer(1, pcm16.length, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 0x8000;
  const source = player.createBufferSource();
  source.buffer = buffer;
  source.connect(player.destination);
  nextPlayAt = Math.max(nextPlayAt, player.currentTime);
  source.start(nextPlayAt);
  nextPlayAt += buffer.duration;
}
function stopPlaying() {
  if (player) { void player.close(); player = null; }
  nextPlayAt = 0;
}

/* ---------- the conversation itself ---------- */

async function begin() {
  const made = await fetch("/api/voice/live", {
    method: "POST", headers: { authorization: "Bearer " + token(), "content-type": "application/json" },
    body: JSON.stringify({ sessionId: globalThis.branchSessionId?.() ?? null }),
  });
  const opened = await made.json();
  if (!made.ok) throw new Error(opened.error || "A live conversation could not be started");
  // A live conversation started before anything was typed makes the conversation. The rest of the
  // app takes the same one, so what is said and what is typed afterwards stay in one thread.
  globalThis.branchAdoptSession?.(opened.sessionId);
  const url = new URL(`/api/runs/${opened.runId}/ws`, location.href).href.replace(/^http/, "ws");
  socket = new WebSocket(url, ["bearer", token()]);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => receive(event.data));
  socket.addEventListener("close", () => end("The connection closed"));
  await new Promise((done, failed) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => failed(new Error("The connection could not be opened")), { once: true });
  });
  socket.send(JSON.stringify({ live: "start" }));
  microphone = await openMicrophone((bytes) => { if (socket?.readyState === 1) socket.send(bytes); });
  show("listening-live");
}

function receive(data) {
  if (data instanceof ArrayBuffer) { play(readAudioFrame(data).pcm16); if (state === "listening-live") show("speaking"); return; }
  let payload;
  try { payload = JSON.parse(data); } catch { return; }
  const body = payload.data ?? {};
  if (payload.kind === "voice.live.refused" || payload.kind === "voice.live.problem") { say(body.message); end(body.message); return; }
  if (payload.kind === "voice.live.transcript") { transcript(body); return; }
  if (payload.kind === "voice.live.capped") { say(body.sentence); return; }
  if (payload.kind === "voice.live.tool" && body.decision === "ask") say("It wants to do something — answer the question on screen.");
  if (payload.kind === "voice.live.ended") end(body.reason);
}
/** What either side said, put in the conversation the moment a whole sentence has been heard. */
function transcript(part) {
  if (!part.final) return;
  globalThis.branchAddSpokenMessage?.(part.who === "person" ? "user" : "assistant", part.text);
}

/** Pressing the button: start, cut in, or stop, depending on where the conversation has got to. */
async function press() {
  try {
    if (state === "idle") { await begin(); return; }
    if (state === "speaking") {
      stopPlaying();
      socket?.send(JSON.stringify({ live: "interrupt" }));
      show("interrupted");
      setTimeout(() => { if (state === "interrupted") show("listening-live"); }, 400);
      return;
    }
    stop();
  } catch (error) {
    say(error.message);
    end(error.message);
  }
}
function stop() {
  try { socket?.send(JSON.stringify({ live: "stop" })); } catch { /* already gone */ }
  end("You ended the conversation");
}
function end(reason) {
  if (state === "idle") return;
  microphone?.close();
  microphone = null;
  stopPlaying();
  try { socket?.close(); } catch { /* already gone */ }
  socket = null;
  show("idle");
  if (reason) say(reason);
}
/**
 * A line typed while it is talking. The assistant answers in the same voice without the person
 * having to wait for it to finish — which is the whole point of typing instead.
 */
globalThis.branchSayLive = function branchSayLive(text) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify({ live: "say", text: String(text).slice(0, 4000) }));
  return true;
};
/** Bucket 17: a picture shown while talking live; false when no live conversation is open. */
globalThis.branchShowLive = function branchShowLive(picture) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify({ live: "picture", mediaType: picture.mediaType, data: picture.data, name: picture.name }));
  return true;
};
globalThis.branchLiveState = () => state;

/* ---------- showing the button at all ---------- */

/** Asks whether the connection in use can hold a live conversation, and shows the button if so. */
export async function refreshLiveButton() {
  const button = $("voice-live");
  if (!button || !token()) return;
  try {
    const response = await fetch("/api/voice/plan", { headers: { authorization: "Bearer " + token() } });
    const plan = await response.json();
    button.hidden = !(plan.live?.available === true);
    button.title = plan.live?.reason ?? button.title;
  } catch { button.hidden = true; }
}

function start() {
  $("voice-live")?.addEventListener("click", () => void press());
  show("idle");
  void refreshLiveButton();
}
// Nothing here runs outside a browser, so the two pieces that are pure arithmetic — turning the
// microphone's sound into PCM16 and reading a numbered block of sound off the socket — can be
// checked on their own against the server's own code, with no screen and no sound card.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  const waiting = globalThis.branchVoiceReady;
  globalThis.branchVoiceReady = () => { waiting?.(); void refreshLiveButton(); };
}
