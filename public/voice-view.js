/* Redesign phase 2 "rooms" (critique #33): Talk live in a view of its own, like the voice modes of
   ChatGPT and Codex. A circle that moves with the real sound (yours going up, the answer coming back),
   what each of you says as it is said, Mute, Cut in, Show the chat, and End. While the message box
   is empty the send button offers Talk live.

   Behind a switch (Settings › Voice, "Talk live in its own view"), off at first. It is built on the
   live conversation that was already there (public/voice-live.js, src/realtime-voice.ts): this file
   opens no microphone and no connection of its own; it presses the same button. The microphone is
   asked for the first time Talk live is pressed, never before. Colours only through tokens. */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (w, n) => (values && n in values ? String(values[n]) : w)) : word;
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function press(className, text, handler) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", () => handler(node));
  return node;
}
const SERVICES = { openai: "OpenAI", gemini: "Google Gemini" };
let plan = null;       // GET /api/voice/plan: { settings, live }
let liveState = "idle";

const viewOn = () => plan?.settings?.liveView === "on";
const liveReady = () => plan?.live?.available === true && globalThis.branchRooms?.liveAllowed?.() !== false;
const ready = () => $("workspace")?.hidden === false && Boolean(sessionStorage.getItem("branch-token"));
async function refresh() {
  if (!ready()) return;
  plan = await api("voice/plan").catch(() => null);
  paintSend();
}

/* ---------- the send button, while the box is empty ---------- */
const WAVE = "M6 10v4M10 7v10M14 9v6M18 11v2";
function waveIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("voice-send-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", WAVE);
  svg.append(path);
  return svg;
}
/** True when pressing send would start Talk live instead of sending. */
const offersTalk = () => viewOn() && liveReady() && liveState === "idle" && !$("prompt")?.value.trim() && !$("send")?.disabled;
function paintSend() {
  const send = $("send");
  if (!send) return;
  const talk = offersTalk();
  if (talk === send.classList.contains("voice-send")) return;
  send.classList.toggle("voice-send", talk);
  if (talk) {
    send.dataset.voiceLabel = send.getAttribute("aria-label") ?? "";
    send.dataset.voiceTitle = send.title;
    send.setAttribute("aria-label", say("voiceView.talk", "Talk live"));
    send.title = say("voiceView.talkHint", "Talk live: speak, and hear the answer as it is said");
    send.append(waveIcon());
  } else {
    send.setAttribute("aria-label", send.dataset.voiceLabel || say("composer.send", "Send"));
    send.title = send.dataset.voiceTitle ?? "";
    send.querySelector(".voice-send-icon")?.remove();
  }
}
/* Ahead of the window's own send: an empty box with Talk live offered starts Talk live. */
document.addEventListener("click", (event) => {
  const send = event.target instanceof Element ? event.target.closest("#send") : null;
  if (!send || !send.classList.contains("voice-send") || !offersTalk()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openView();
  // A start that fails (no microphone given, no connection) says why and leaves the view closed.
  void Promise.resolve(globalThis.branchLive?.press()).finally(() => { if ((globalThis.branchLiveState?.() ?? "idle") === "idle") closeView(); });
}, true);

/* ---------- the view ---------- */
const STATUS = {
  idle: ["voiceView.starting", "Starting…"],
  "listening-live": ["voiceView.listening", "Listening"],
  speaking: ["voiceView.speaking", "Answering: press Cut in to speak"],
  interrupted: ["voiceView.interrupted", "Stopping: carry on talking"],
};
function viewNode() { return $("voice-view"); }
function openView() {
  if (viewNode()) { viewNode().classList.remove("mini"); return; }
  const view = el("section", "voice-view");
  view.id = "voice-view";
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-label", say("voiceView.title", "Talk live"));
  const service = SERVICES[plan?.live?.service] ?? say("voiceView.theService", "the service");
  const status = el("span", "voice-view-status", say(...STATUS.idle));
  status.id = "voice-view-status";
  status.setAttribute("aria-live", "polite");
  const top = el("div", "voice-view-top");
  top.append(el("b", "", say("voiceView.title", "Talk live")), status, el("span", "voice-view-live", say("voiceView.live", "Live")));
  const orb = el("canvas", "voice-view-orb");
  orb.id = "voice-view-orb";
  orb.width = 280; orb.height = 280;
  orb.setAttribute("aria-hidden", "true");
  const captions = el("div", "voice-view-captions");
  captions.id = "voice-view-captions";
  captions.setAttribute("aria-live", "polite");
  const ask = el("p", "voice-view-ask", "");
  ask.id = "voice-view-ask";
  ask.hidden = true;
  view.append(top, orb, captions, ask, buttons(),
    el("p", "voice-view-note", say("voiceView.note", "Your voice goes to {service} while you talk. Both sides are written into the conversation. The sound itself is not kept.", { service })));
  ($("chat") ?? document.body).append(view);
  draw();
}
function buttons() {
  const row = el("div", "voice-view-buttons");
  const mute = press("voice-view-button", say("voiceView.mute", "Mute"), (node) => {
    const now = globalThis.branchLive?.mute(!globalThis.branchLive.muted()) ?? false;
    node.setAttribute("aria-pressed", String(now));
    node.textContent = now ? say("voiceView.unmute", "Unmute") : say("voiceView.mute", "Mute");
  });
  mute.setAttribute("aria-pressed", "false");
  const cut = press("voice-view-button", say("voiceView.cutIn", "Cut in"), () => globalThis.branchLive?.press());
  cut.id = "voice-view-cut";
  cut.hidden = true;
  const chat = press("voice-view-button", say("voiceView.showChat", "Show the chat"), (node) => {
    const mini = viewNode()?.classList.toggle("mini");
    node.textContent = mini ? say("voiceView.backToVoice", "Back to voice") : say("voiceView.showChat", "Show the chat");
  });
  chat.id = "voice-view-chat";
  const end = press("voice-view-button voice-view-end", say("voiceView.end", "End"), () => { globalThis.branchLive?.stop(); closeView(); });
  row.append(mute, cut, chat, end);
  return row;
}
function closeView() {
  cancelAnimationFrame(frame);
  viewNode()?.remove();
}

/* ---------- the circle, moved by the real sound ---------- */
let frame = 0;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || Boolean(document.documentElement.dataset.motion === "off");
function draw() {
  const canvas = $("voice-view-orb");
  if (!canvas) return;
  const g = canvas.getContext("2d");
  const style = getComputedStyle(document.documentElement);
  const colour = style.getPropertyValue("--copper").trim() || style.getPropertyValue("--accent").trim();
  const { input, output } = globalThis.branchLive?.levels() ?? { input: 0, output: 0 };
  const level = liveState === "speaking" ? output : input;
  const size = canvas.width, middle = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = colour;
  for (let ring = 3; ring >= 1; ring--) {
    g.globalAlpha = 0.12 * (4 - ring);
    g.beginPath();
    g.arc(middle, middle, 62 + ring * 16 + level * 30 * ring, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.beginPath();
  g.arc(middle, middle, 56 + level * 14, 0, Math.PI * 2);
  g.fill();
  if (!still()) frame = requestAnimationFrame(draw);
}

/* ---------- what each side says, as it is said ---------- */
function caption(detail) {
  const box = $("voice-view-captions");
  if (!box || !detail.text) return;
  let line = box.querySelector(`.voice-cap-${detail.who}.live`);
  if (!line) {
    line = el("p", `voice-cap voice-cap-${detail.who} live`);
    line.append(el("b", "", detail.who === "you" ? say("voiceView.you", "You") : say("voiceView.assistant", "Your assistant")), el("span", "", ""));
    box.append(line);
  }
  line.querySelector("span").textContent = ` ${detail.text}`;
  if (detail.final) line.classList.remove("live");
  while (box.children.length > 6) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

/* ---------- following the conversation ---------- */
document.addEventListener("branch-live-state", (event) => {
  liveState = event.detail?.state ?? "idle";
  paintSend();
  if (!viewOn()) return;
  if (liveState === "idle") { closeView(); return; }
  openView();
  const status = $("voice-view-status");
  if (status) status.textContent = say(...(STATUS[liveState] ?? STATUS.idle));
  const cut = $("voice-view-cut");
  if (cut) cut.hidden = liveState !== "speaking";
  if (still()) draw();
});
document.addEventListener("branch-live-transcript", (event) => { if (viewNode()) caption(event.detail ?? {}); });
/* A question mid-conversation: the view folds away so its card, in the conversation, can be answered. */
document.addEventListener("branch-live-ask", (event) => {
  const view = viewNode();
  if (!view) return;
  view.classList.add("mini");
  const ask = $("voice-view-ask");
  if (ask) { ask.hidden = false; ask.textContent = say("voiceView.ask", "It wants to do something: answer the question in the conversation, by tapping, and it carries on."); }
  const chat = $("voice-view-chat");
  if (chat) chat.textContent = say("voiceView.backToVoice", "Back to voice");
  void event;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !viewNode() || viewNode().classList.contains("mini")) return;
  event.preventDefault();
  globalThis.branchLive?.stop();
  closeView();
});
document.addEventListener("branch-rooms-changed", () => { paintSend(); void import("/voice-live.js").then((m) => m.refreshLiveButton?.()).catch(() => undefined); });
$("prompt")?.addEventListener("input", paintSend);
const send = $("send");
if (send) new MutationObserver(paintSend).observe(send, { attributes: true, attributeFilter: ["disabled"] });
const workspace = $("workspace");
if (workspace) new MutationObserver(() => void refresh()).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
$("voice-live-view")?.addEventListener("change", () => setTimeout(() => void refresh(), 600));
globalThis.branchVoiceView = { refresh, open: openView, close: closeView };
void refresh();
