/**
 * w911 (A2144): MV3 background service worker for context menu handling.
 * Records right-clicked elements and sends annotation directives to Branch.
 */

// Keep track of the last right-clicked element
let lastClickedElement = null;

// Set up context menu items for the four directive kinds
chrome.contextMenus.removeAll(() => {
  const kinds = ["inspect", "change", "lift", "comment"];
  for (const kind of kinds) {
    chrome.contextMenus.create({
      id: `annotate-${kind}`,
      title: `Note this (${kind})`,
      contexts: ["all"],
    });
  }
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const match = /^annotate-(.+)$/.exec(info.menuItemId);
  if (!match || !tab?.id) return;

  const kind = match[1];
  const where = (await chrome.storage?.local.get("where"))?.where || "";
  const key = (await chrome.storage?.local.get("key"))?.key || "";

  if (!where || !key) {
    console.log("Configure Branch address and key first");
    return;
  }

  try {
    // Ask the content script to capture the element that was right-clicked
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Return the element info stored by the content script
        return window.__lastClickedElement || null;
      },
    });

    if (!result?.result) {
      console.log("Could not capture element");
      return;
    }

    const directive = {
      kind,
      ...result.result,
    };

    // Prompt for a note
    const note = await new Promise((resolve) => {
      const frame = chrome.extension.getBackgroundPage();
      if (frame && frame.window) {
        resolve(frame.window.prompt("Add a note (optional):") || "");
      } else {
        resolve("");
      }
    });

    directive.note = note;

    const response = await fetch(where + "/api/browser/notes", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(directive),
    });

    if (!response.ok) {
      console.log("Failed to note element:", await response.text());
    }
  } catch (error) {
    console.log("Error:", error.message);
  }
});
