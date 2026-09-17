/** Send to Branch (what the share sheet or the file picker brought in) and the talk button. */
import { planShare, refusal } from "/rules.js";
import { $, describe, phone, plugin, say, status } from "/phone-common.js";

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

export function drawShared() {
  const rows = phone.shared.map((item) => {
    const row = document.createElement("li");
    row.textContent = item.kind === "file" ? item.name : item.text;
    return row;
  });
  $("send-items").replaceChildren(...rows);
}

export async function addFiles(list) {
  for (const file of list) phone.shared.push({ kind: "file", name: file.name, type: file.type, data: await readAsBase64(file) });
  drawShared();
}

export async function send() {
  // A switch that is off refuses, whatever the page shows.
  if ((await phone.vault.switches()).share === "off") { status("send-status", say("phone.share.off", "Sending from the share sheet is off. Turn it on in Branch, under On this phone."), true); return; }
  const { requests, refused } = planShare(phone.shared, $("send-note").value);
  if (!requests.length) { status("send-status", say("phone.send.nothing", "Add some words, a picture or a file first."), true); return; }
  $("send").disabled = true;
  status("send-status", say("phone.send.sending", "Sending…"));
  try {
    for (const request of requests) await phone.vault.request(request.method, request.path, request.body);
    phone.shared = [];
    $("send-note").value = "";
    drawShared();
    await plugin.clearShared?.();
    const skipped = refused.length ? say("phone.send.skipped", "{count} could not be sent (too big or unreadable).", { count: refused.length }) : "";
    status("send-status", `${say("phone.send.sent", "Sent. It is waiting in your Branch.")} ${skipped}`.trim());
  } catch (error) {
    status("send-status", describe(error), true);
  } finally {
    $("send").disabled = false;
  }
}

/* ---------- talk: hold, speak, let go ---------- */
let recorder = null;
let startedAt = 0;
export async function startTalking() {
  if (recorder) return;
  if ((await phone.vault.switches()).voice === "off") { status("talk-status", say("phone.talk.off", "The talk button is off. Turn it on below, under On this phone."), true); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => { for (const track of stream.getTracks()) track.stop(); void finishTalking(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start();
    startedAt = Date.now();
    $("talk").classList.add("recording");
    status("talk-status", say("phone.talk.listening", "Listening… let go to send."));
  } catch {
    recorder = null;
    status("talk-status", say("phone.talk.noMicrophone", "The microphone could not be opened."), true);
  }
}
export function stopTalking() { if (recorder?.state === "recording") recorder.stop(); }

async function finishTalking(blob) {
  $("talk").classList.remove("recording");
  recorder = null;
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  status("talk-status", say("phone.talk.writing", "Writing it out on your computer…"));
  try {
    const base64 = await readAsBase64(blob);
    const contentType = (blob.type || "audio/mp4").split(";")[0];
    const written = await phone.vault.request("POST", "/api/voice/transcribe", null, { base64, contentType, query: `seconds=${seconds}` });
    if (!written?.text?.trim()) throw refusal("phone.talk.empty", "Nothing was heard. Try again.");
    await phone.vault.request("POST", "/api/run", { prompt: written.text.trim().slice(0, 16000) });
    status("talk-status", say("phone.talk.sent", "Sent: “{words}”", { words: written.text.trim().slice(0, 120) }));
  } catch (error) {
    status("talk-status", describe(error), true);
  }
}
