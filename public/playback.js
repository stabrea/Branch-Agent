/**
 * FQ-surfaces.playback: an attached sound or video file plays inline, right in the conversation
 * client, instead of only being turned into words or still pictures (public/media.js does that
 * turning). This file adds the other half: a small player, first on the message box while the
 * file is still attached, then again inside the message once it is sent.
 */
const $ = (id) => document.getElementById(id);
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
/** Sound and video kept as their own URLs, in the shape the composer chip and the sent message both use. */
let pending = [];

function clipKind(mediaType) {
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return null;
}
/** One <audio> or <video> element with the browser's own controls; nothing here invents a transport. */
function player(clip) {
  const node = document.createElement(clip.kind);
  node.controls = true;
  node.preload = "metadata";
  node.src = clip.url;
  if (clip.kind === "video") node.className = "clip-video";
  return node;
}
function renderComposerClips() {
  const row = $("composer-clips");
  if (!row) return;
  row.replaceChildren();
  row.hidden = pending.length === 0;
  for (const clip of pending) {
    const chip = el("span", "attachment clip-chip");
    const label = el("span");
    label.textContent = clip.name;
    chip.append(player(clip), label);
    const remove = el("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Take ${clip.name} off this message`;
    remove.addEventListener("click", () => {
      pending = pending.filter((other) => other !== clip);
      URL.revokeObjectURL(clip.url);
      renderComposerClips();
    });
    chip.append(remove);
    row.append(chip);
  }
}
/**
 * Called by public/media.js the moment an audio or video file is picked or dropped, alongside
 * (not instead of) that file's own transcribing or frame-taking. The raw file plays back exactly
 * as attached; nothing here waits on that other work finishing, or needs it to succeed.
 */
function attach(file) {
  const kind = clipKind(file.type);
  if (!kind) return;
  pending.push({ kind, mediaType: file.type, name: file.name, url: URL.createObjectURL(file) });
  renderComposerClips();
}
/** What the next sent message should carry for inline playback; the composer chips are then cleared. */
function take() {
  const clips = pending;
  pending = [];
  renderComposerClips();
  return clips;
}
/**
 * Remembered by the exact words of the message it went out with, so the player survives the
 * conversation being redrawn from what the server saved — which knows the words but not the file,
 * since the clip never leaves this browser. Capped so a long-running conversation cannot grow this
 * without bound.
 */
const sentClips = new Map();
/** Puts a playable clip inside an already-built message bubble. public/app.js calls this for every
 *  user turn, both the one just sent (with its clips) and every one redrawn from saved history
 *  (with none, `content` being how last time's clips are found again). */
function render(container, content, clips) {
  if (clips?.length) {
    if (sentClips.size >= 200) sentClips.delete(sentClips.keys().next().value);
    sentClips.set(content, clips);
  }
  const use = clips?.length ? clips : sentClips.get(content);
  if (!use?.length) return;
  const wrap = el("div", "message-clips");
  for (const clip of use) wrap.append(player(clip));
  container.append(wrap);
}
globalThis.branchPlaybackAttach = attach;
globalThis.branchPlaybackAttachments = take;
globalThis.branchPlaybackRender = render;
