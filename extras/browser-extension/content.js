/**
 * w911 (A2144): Content script for capturing right-clicked element information.
 * Runs in page context and records element details for annotation.
 */

// Store the last right-clicked element information
window.__lastClickedElement = null;

document.addEventListener("contextmenu", (event) => {
  const target = event.target;
  if (!target) return;

  const tag = target.tagName.toLowerCase();
  const text = ((target).innerText ?? target.textContent ?? "").trim().slice(0, 200);

  // Build a cleaned outerHTML without password values or scripts
  let html = target.outerHTML;
  html = html.replace(/<script[^>]*>.*?<\/script>/gs, "");
  html = html.replace(/type\s*=\s*["']?password["']?[^>]*value\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+value\s*=\s*["'][^"']*["']/gi, "");
  html = html.slice(0, 1000);

  // Extract some computed styles
  const computed = window.getComputedStyle(target);
  const styles = {};
  for (const prop of ["display", "visibility", "color", "backgroundColor"]) {
    const val = computed.getPropertyValue(prop);
    if (val) styles[prop] = val.slice(0, 100);
  }

  // Build parent chain
  const chain = [];
  for (let node = target.parentElement; node && chain.length < 10; node = node.parentElement) {
    chain.push(node.tagName.toLowerCase());
  }

  // Build a selector
  let selector = tag;
  if (target.id) selector = `#${target.id}`;
  else if (target.className) selector = `.${target.className.split(" ")[0]}`;

  // Strip credentials from page URL
  let pageUrl = location.href;
  try {
    const url = new URL(pageUrl);
    url.username = "";
    url.password = "";
    pageUrl = url.toString();
  } catch {
    pageUrl = location.href.replace(/https?:\/\/[^:@/]*(?::[^@/]*)?@/, "https://");
  }

  // Store for the service worker to access
  window.__lastClickedElement = {
    kind: "inspect",
    pageUrl,
    selector,
    tag,
    text,
    outerHTML: html,
    styles,
    parentChain: chain,
    note: "",
  };
});
