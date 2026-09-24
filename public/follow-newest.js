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
    if (box && chatShown()) box.scrollTop = box.scrollHeight;
  });
}

function keepUp() {
  if (following && chatShown()) followNewest();
}

const box = scroller();
if (box) box.addEventListener("scroll", () => { following = atBottom(box); }, { passive: true });
$("chat-form")?.addEventListener("submit", followNewest);
const watched = [$("conversation"), $("live-row")].filter(Boolean);
const observer = new MutationObserver(keepUp);
for (const node of watched) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
/* Opening another conversation starts at its newest message. */
new MutationObserver(followNewest).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
globalThis.branchFollowNewest = { follow: followNewest, get following() { return following; } };
