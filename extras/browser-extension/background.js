/**
 * w911 (A2144): the right-click menu. Four entries — look at this, change this, lift this out, and
 * comment on this — turn the thing you right-clicked into a page note on your paired Branch.
 *
 * content.js remembers what was right-clicked and makes the cleaned copy; this file only asks for it
 * and sends it. It uses the address the popup remembered and the key the popup keeps in the browser's
 * memory for this session (chrome.storage.session, never written to disk), and it refuses this
 * computer's own address exactly as the popup does.
 */
import { hostPattern, isLoopback } from "./address.js";

export const noteKinds = [
  ["inspect", "Branch: look at this"],
  ["change", "Branch: change this"],
  ["lift", "Branch: lift this out"],
  ["comment", "Branch: comment on this"],
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [kind, title] of noteKinds) chrome.contextMenus.create({ id: `branch-note-${kind}`, title, contexts: ["all"] });
  });
});

/** Says how it went on the extension's button: a short badge, and the reason when you point at it. */
function tell(tabId, badge, words) {
  chrome.action.setBadgeText({ tabId, text: badge });
  chrome.action.setTitle({ tabId, title: `Send to Branch: ${words}` });
}

/** Where to send, or the reason nothing can be sent. */
async function destination() {
  const { where } = await chrome.storage.local.get("where");
  const { key } = await chrome.storage.session.get("key");
  if (!where || !key) return { refused: "open Send to Branch and send once, so it knows your paired address and key." };
  if (isLoopback(where)) return { refused: "it will not talk to Branch on this computer's own address." };
  if (!(await chrome.permissions.contains({ origins: [hostPattern(where)] })))
    return { refused: "Chrome has not allowed it to reach your Branch yet; send once from the popup." };
  return { where, key };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const kind = /^branch-note-(inspect|change|lift|comment)$/.exec(String(info.menuItemId))?.[1];
  if (!kind || tab?.id === undefined) return;
  try {
    const to = await destination();
    if (to.refused) { tell(tab.id, "!", to.refused); return; }
    const note = await chrome.tabs.sendMessage(tab.id, { type: "branch-note", kind }, { frameId: info.frameId ?? 0 });
    if (!note) { tell(tab.id, "", "nothing was sent."); return; }
    const response = await fetch(`${to.where}/api/browser/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${to.key}`, "content-type": "application/json" },
      body: JSON.stringify(note),
    });
    const answer = await response.json().catch(() => ({}));
    tell(tab.id, response.ok ? "✓" : "!", response.ok ? "the note reached Branch." : String(answer.error ?? "Branch did not take it."));
  } catch (error) {
    tell(tab.id, "!", error instanceof Error ? error.message : "that did not work.");
  }
});
