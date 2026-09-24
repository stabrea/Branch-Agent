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
 * Clips of messages the server has saved, by conversation and saved message number
 * (`${sessionId}:${messageId}`), so the player survives the conversation being redrawn from what the
 * server saved — which knows the message but not the file, since the clip never leaves this browser.
 * Not keyed by the message's words: the server saves them with "[attached picture: …]" (or a
 * specialist's number) added, and the same words can be sent again with no file, in any conversation.
 * Capped so a long-running page cannot grow this without bound.
 *
 * Coordinator ruling: a clip lives only in this page's memory for now, so a reload or another device
 * shows the message without its player. Durable playback comes with the per-conversation attachment
 * store (#190).
 */
const sentClips = new Map();
/** The highest saved user message number drawn so far, per conversation. */
const drawnUpTo = new Map();
/** Clips just sent and not yet matched to the message the server saved for them. */
let expected = null;

function remember(key, clips) {
  if (sentClips.size >= 200) sentClips.delete(sentClips.keys().next().value);
  sentClips.set(key, clips);
}
/**
 * Called by public/app.js once the send has come back and before the conversation is redrawn: these
 * clips were sent with the message with the exact given messageId (FQ-surfaces). If the redraw fails,
 * the clips are settled away.
 */
function expect(sessionId, clips, messageId) {
  expected = sessionId && clips?.length && typeof messageId === 'number' ? { sessionId, messageId, clips } : null;
}
/** Clips the redraw did not match (it failed, or the send did) are dropped, never handed to a later message. */
function settle() { expected = null; }
/** Puts a playable clip inside an already-built message bubble. public/app.js calls this for every
 *  user turn: the one just sent (its `source.clips`, before the server has saved it) and every one
 *  redrawn from saved history (its `source.messageId`, how its clips are found again). */
function render(container, sessionId, source) {
  let use = source?.clips;
  const id = source?.messageId;
  if (sessionId && id) {
    const key = `${sessionId}:${id}`;
    if (expected?.sessionId === sessionId && id === expected.messageId) {
      remember(key, expected.clips);
      expected = null;
    }
    use = sentClips.get(key);
  }
  if (!use?.length) return;
  const wrap = el("div", "message-clips");
  for (const clip of use) wrap.append(player(clip));
  container.append(wrap);
}
globalThis.branchPlaybackAttach = attach;
globalThis.branchPlaybackAttachments = take;
globalThis.branchPlaybackRender = render;
globalThis.branchPlaybackExpect = expect;
globalThis.branchPlaybackSettle = settle;
