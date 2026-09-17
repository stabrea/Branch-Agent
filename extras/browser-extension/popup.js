/**
 * The popup: takes the address of the page you are looking at, and whatever you have selected on
 * it, and sends them to your own Branch as a task. Also provides context menu to annotate elements.
 *
 * It talks only to the paired remote listener, with the key pairing gave you, and it refuses a
 * loopback address outright — the key the app's own page uses on your computer is the whole of
 * Branch's authority there, and an extension must not be able to borrow it.
 *
 * w911 (A2144): Added context menu support for element annotation via "Note this for Branch".
 */
const $ = (id) => document.getElementById(id);
const say = (message) => { $("said").textContent = message; };

/** Set up context menu when extension loads. */
function setupContextMenu() {
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus?.create({
      id: "annotate-element",
      title: "Note this for Branch",
      contexts: ["all"]
    });
  });
}
setupContextMenu();

/** This computer talking to itself, which this extension will not do. */
export function isLoopback(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

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
export function hostPattern(where) {
  const url = new URL(where);
  return `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}/*`;
}
async function mayReach(where) {
  const origins = [hostPattern(where)];
  if (await chrome.permissions?.contains({ origins })) return true;
  return Boolean(await chrome.permissions?.request({ origins }));
}

/* The address and key are remembered in the extension's own storage, never in the page. */
chrome.storage?.local.get(["where"]).then((saved) => { if (saved.where) $("where").value = saved.where; });

$("send").addEventListener("click", async () => {
  const where = $("where").value.trim().replace(/\/$/, ""), key = $("key").value.trim();
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
    const response = await fetch(where + "/api/run", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ prompt: taskFrom(page, $("note").value) }),
    });
    const data = await response.json();
    say(response.ok ? String(data.output ?? "Sent.") : String(data.error ?? "That did not work."));
  } catch (error) { say(error.message); }
});

/** w911 (A2144): Handle "Note this for Branch" context menu. */
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "annotate-element" || !tab?.id) return;
  const where = (await chrome.storage?.local.get("where"))?.where || "";
  const key = (await chrome.storage?.local.get("key"))?.key || "";
  if (!where || !key || isLoopback(where)) {
    say("Configure your Branch address and key first.");
    return;
  }

  try {
    if (!(await mayReach(where))) {
      say("Chrome needs your permission for that address.");
      return;
    }
    say("Capturing element…");

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureElementAtPoint,
      args: [info.frameId === 0 ? info.frameUrl : tab.url]
    });

    if (!result?.result) {
      say("Could not capture element.");
      return;
    }

    const directive = result.result;
    const response = await fetch(where + "/api/browser/notes", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(directive)
    });

    say(response.ok ? "Element noted." : "Failed to note element.");
  } catch (error) {
    say(error.message);
  }
});

/** Runs in the content script context to capture the right-clicked element. */
function captureElementAtPoint(pageUrl) {
  const target = document.elementFromPoint(window.event?.clientX || 0, window.event?.clientY || 0);
  if (!target) return null;

  const tag = target.tagName.toLowerCase();
  const text = ((target).innerText ?? target.textContent ?? "").trim().slice(0, 200);

  // Build trimmed outerHTML without script contents or password values
  let html = target.outerHTML.replace(/<script[^>]*>.*?<\/script>/gs, "");
  html = html.replace(/type\s*=\s*["']?password["']?[^>]*value\s*=\s*["'][^"']*["']/gi, "");
  html = html.slice(0, 1000);

  // Extract selector
  let selector = tag;
  if (target.id) selector = `#${target.id}`;
  else if (target.className) selector = `.${target.className.split(" ")[0]}`;

  const styles = {};
  const computed = window.getComputedStyle(target);
  for (const prop of ["display", "visibility", "color", "backgroundColor"]) {
    const val = computed.getPropertyValue(prop);
    if (val) styles[prop] = val.slice(0, 100);
  }

  const chain = [];
  for (let node = target.parentElement; node && chain.length < 10; node = node.parentElement) {
    chain.push(node.tagName.toLowerCase());
  }

  // Strip credentials from URL
  let cleanUrl = pageUrl;
  try {
    const url = new URL(pageUrl);
    url.username = "";
    url.password = "";
    cleanUrl = url.toString();
  } catch {
    cleanUrl = pageUrl.replace(/https?:\/\/[^:@/]*(?::[^@/]*)?@/, "https://");
  }

  return {
    kind: "inspect",
    pageUrl: cleanUrl,
    selector,
    tag,
    text,
    outerHTML: html,
    styles,
    parentChain: chain,
    note: ""
  };
}
