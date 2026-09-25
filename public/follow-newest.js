/**
 * Dogfood B5: the conversation follows its newest message, as Claude Code's and ChatGPT's do. Sending a message
 * goes to the bottom; while the answer, its steps and any question it stops on arrive, the view keeps up, but only
 * when it was already at the bottom, so someone reading further up is never pulled away.
 */
const $ = (id) => document.getElementById(id);
/** How close to the bottom still counts as at the bottom, in pixels. */
const NEAR = 80;

const scroller = () => $("workspace");
const chatShown = () => Boolean($("chat")?.checkVisibility?.() ?? !$("chat")?.hidden);
const atBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR;

/** Whether the view is following the newest message; reading upwards turns it off, getting back down turns it on. */
let following = true;
let frame = 0;

/** Goes to the bottom on the next frame, once what was just added has its height. */
export function followNewest() {
  following = true;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const box = scroller();
    // Someone who scrolled up before this frame came round is reading: they are not pulled back down.
    if (box && following && chatShown()) box.scrollTop = box.scrollHeight;
  });
}

function keepUp() {
  if (following && chatShown()) followNewest();
}

const box = scroller();
/* Only the person stops following, by moving up (the wheel, a finger, the keys, the scroll bar). The page itself
   moves the view too: a redraw that empties the conversation for a moment pulls it up, and a scroll this file caused
   can arrive after more was added, so what a scroll event says is never taken as the person's wish. Reaching the
   bottom again, however they get there, follows again. */
const reading = () => { following = false; };
if (box) {
  box.addEventListener("wheel", (event) => { if (event.deltaY < 0) reading(); }, { passive: true });
  let touchY = null;
  box.addEventListener("touchstart", (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  box.addEventListener("touchmove", (event) => { const y = event.touches[0]?.clientY; if (touchY !== null && y > touchY + 8) reading(); }, { passive: true });
  // Q197 (NAS b613f63): keys that scroll up, Shift+Space too, wherever the focus is but a field: a key pressed with
  // the focus on the page itself (after a click on the live row, say) scrolls the view without reaching it.
  document.addEventListener("keydown", (event) => {
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (event.target !== document.body && !box.contains(event.target)) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) reading();
  });
  /* A press on the box itself, not on anything in it, is its scroll bar. */
  box.addEventListener("pointerdown", (event) => { if (event.target === box) reading(); });
  box.addEventListener("scroll", () => { if (atBottom(box)) following = true; }, { passive: true });
}
/* A send under way: its conversation gets its id when the answer lands, and that is not the person opening one. Set
   only while public/app.js really sends (NAS f050949): a slash command, a box of spaces or a first send that fails
   used to leave it set, and the next conversation opened from Recents then started at its top. */
let sending = false;
$("chat-form")?.addEventListener("submit", () => followNewest());
document.addEventListener("branch-send-started", () => { sending = true; });
document.addEventListener("branch-send-settled", () => { sending = false; });
const watched = [$("conversation"), $("live-row")].filter(Boolean);
const observer = new MutationObserver(keepUp);
for (const node of watched) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
/* Opening another conversation starts at its newest message. The same conversation set again (the window reloads it
   when an answer lands) is not another one, nor is a new conversation getting its id on its first send: someone may
   have scrolled up to read while it worked (NAS 545cb4d). */
let shownSession = $("conversation")?.dataset.sessionId ?? "";
new MutationObserver(() => {
  const now = $("conversation")?.dataset.sessionId ?? "";
  // From none: a first send's id arriving leaves a reader where they are; one opened from Recents starts at its
  // newest message even after a scroll up on the empty screen (Q198, NAS e87c522).
  const opened = now !== shownSession && (shownSession !== "" || !sending);
  sending = false; // the window writes the id when an answer lands, so a send has settled by now
  shownSession = now;
  if (opened) followNewest();
}).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
globalThis.branchFollowNewest = { follow: followNewest, get following() { return following; } };
