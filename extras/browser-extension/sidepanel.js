/**
 * The side panel: a conversation with your own Branch beside the page you are reading (A1611).
 * The address is remembered in the extension's own storage; the key is kept only while the panel is
 * open. See chat.js for what is sent and why this computer's own address is refused.
 */
import { hostPattern, messageFor, refusal, sendTurn } from "./chat.js";

const $ = (id) => document.getElementById(id);
/** What is typed into one of the panel's own boxes, read through its form, never off the page. */
const typed = (input) => String(new FormData(input.form).get(input.name) ?? "");
const conversation = { sessionId: null };

function show(who, text) {
  const line = document.createElement("p");
  line.className = who;
  line.textContent = text;
  $("log").append(line);
  line.scrollIntoView({ block: "end" });
}

async function pageNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const [got] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ url: location.href, title: document.title, selection: String(getSelection() ?? "").slice(0, 4000) }),
  });
  return got?.result ?? null;
}

async function mayReach(where) {
  const origins = [hostPattern(where)];
  if (await chrome.permissions?.contains({ origins })) return true;
  return Boolean(await chrome.permissions?.request({ origins }));
}

chrome.storage?.local.get(["where"]).then((saved) => { if (saved.where) $("where").setAttribute("value", saved.where); });

$("new").addEventListener("click", () => { conversation.sessionId = null; $("log").textContent = ""; });
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const where = typed($("where")).trim(), key = typed($("key")).trim(), text = typed($("message"));
  const why = refusal(where, key);
  if (why) { show("note", why); return; }
  if (!text.trim() && !$("page").checked) return;
  try {
    if (!(await mayReach(where))) { show("note", "Chrome needs your permission for that address first. Send again and say yes."); return; }
    await chrome.storage?.local.set({ where });
    const prompt = messageFor(text, $("page").checked ? await pageNow() : null);
    show("you", prompt);
    $("message").value = ""; // a write into the panel's own box, not a read of anything on the page
    const turn = await sendTurn(fetch, where, key, prompt, conversation);
    show(turn.ok ? "branch" : "note", turn.answer);
  } catch (error) { show("note", error.message); }
});
