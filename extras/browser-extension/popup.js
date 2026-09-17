/**
 * The popup: takes the address of the page you are looking at, and whatever you have selected on
 * it, and sends them to your own Branch as a task.
 *
 * It talks only to the paired remote listener, with the key pairing gave you, and it refuses a
 * loopback address outright — the key the app's own page uses on your computer is the whole of
 * Branch's authority there, and an extension must not be able to borrow it.
 *
 * w911 (A2144): the address rule lives in address.js, shared with the right-click menu
 * (background.js). Sending once also keeps the key in the browser's memory for this session
 * (chrome.storage.session, never on disk) so the menu can use it; closing the browser forgets it.
 */
import { hostPattern, isLoopback } from "./address.js";

export { isLoopback };
const $ = (id) => document.getElementById(id);
const say = (message) => { $("said").textContent = message; };
/** What is typed into one of the popup's own boxes, read through its form. */
const typed = (input) => String(new FormData(input.form).get(input.name) ?? "");

/** What is on the page: its address, its title, and whatever is selected on it. */
async function pageNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const [got] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ url: location.href, title: document.title, selection: String(getSelection() ?? "").slice(0, 4000) }),
  });
  return got?.result ?? null;
}

/** The words that go to Branch, made of what is on the page and what you added. */
export function taskFrom(page, note) {
  const lines = [note?.trim() || "Have a look at this page and tell me what matters."];
  lines.push("", `Page: ${page.title || "(no title)"}`, `Address: ${page.url}`);
  if (page.selection?.trim()) lines.push("", "What I selected on it:", page.selection.trim());
  return lines.join("\n");
}

/**
 * The one address this extension may reach, asked for at the moment the owner names it. The manifest
 * asks for no website up front, so an extension sitting unused can reach nothing at all; Chrome puts
 * the question to the owner itself, and a no leaves everything exactly as it was.
 */
export { hostPattern };
async function mayReach(where) {
  const origins = [hostPattern(where)];
  if (await chrome.permissions?.contains({ origins })) return true;
  return Boolean(await chrome.permissions?.request({ origins }));
}

/* The address and key are remembered in the extension's own storage, never in the page. */
chrome.storage?.local.get(["where"]).then((saved) => { if (saved.where) $("where").setAttribute("value", saved.where); });

$("send").addEventListener("click", async () => {
  const where = typed($("where")).trim().replace(/\/$/, ""), key = typed($("key")).trim();
  if (!where || !key) { say("Fill in your paired Branch address and its key first."); return; }
  if (isLoopback(where)) {
    say("This extension will not talk to Branch on your computer's own address. Turn on reaching Branch from your phone, pair once, and use that address and key.");
    return;
  }
  try {
    if (!(await mayReach(where))) {
      say("Chrome needs your permission for that address before the extension can reach it. Press Send again and say yes.");
      return;
    }
  } catch (error) { say(error.message); return; }
  say("Sending…");
  try {
    const page = await pageNow();
    if (!page) { say("There is no page to send."); return; }
    await chrome.storage?.local.set({ where });
    await chrome.storage?.session?.set({ key });
    const response = await fetch(where + "/api/run", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ prompt: taskFrom(page, typed($("note"))) }),
    });
    const data = await response.json();
    say(response.ok ? String(data.output ?? "Sent.") : String(data.error ?? "That did not work."));
  } catch (error) { say(error.message); }
});
