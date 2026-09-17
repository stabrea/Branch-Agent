/**
 * w911 (A2144): remembers the last thing you right-clicked, and — only when you pick one of the
 * "Branch:" menu entries — hands back a cleaned copy of it.
 *
 * Everything is read from a copy of the element with scripts, styles, templates and text box
 * contents taken out and every value attribute dropped. It never asks a field what it holds, so a
 * password you typed is never read. The page address loses any sign-in name, password and fragment.
 */
let branchNoteTarget = null;

document.addEventListener("contextmenu", (event) => {
  branchNoteTarget = event.target instanceof Element ? event.target : null;
}, true);

/** A short CSS path that finds the element again. */
function branchNotePath(element) {
  const path = [];
  for (let node = element; node && node !== document.documentElement && path.length < 6; node = node.parentElement) {
    if (node.id) { path.unshift(`#${CSS.escape(node.id)}`); break; }
    const same = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [node];
    path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})`);
  }
  return path.join(" > ").slice(0, 1000);
}

/** The cleaned copy of one element, in the shape Branch accepts. */
function captureNoteTarget(element) {
  const copy = element.cloneNode(true);
  for (const node of [...copy.querySelectorAll("script, style, noscript, template, textarea")]) {
    if (node.tagName.toLowerCase() === "textarea") node.textContent = "";
    else node.remove();
  }
  for (const node of [copy, ...copy.querySelectorAll("*")]) node.removeAttribute("value");
  const describe = (node) => (node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "")
    + (node.classList.length ? `.${[...node.classList].slice(0, 2).join(".")}` : "")).slice(0, 200);
  const parentChain = [];
  for (let node = element.parentElement; node && parentChain.length < 10; node = node.parentElement) parentChain.push(describe(node));
  const computed = getComputedStyle(element), styles = {};
  for (const name of ["display", "visibility", "color", "background-color", "font-size", "width", "height"])
    styles[name] = computed.getPropertyValue(name).slice(0, 200);
  const address = new URL(location.href);
  address.username = ""; address.password = ""; address.hash = "";
  return {
    pageUrl: address.toString().slice(0, 2048), selector: branchNotePath(element), tag: element.tagName.toLowerCase(),
    text: (copy.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
    outerHTML: copy.outerHTML.slice(0, 20000), styles, parentChain,
  };
}

const branchNoteQuestion = {
  change: "What should Branch change about this?",
  lift: "What should Branch do with this once it has lifted it out? (optional)",
  comment: "Your comment for Branch:",
};

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== "branch-note" || !branchNoteTarget) { reply(null); return; }
    const question = branchNoteQuestion[message.kind];
    const note = question ? window.prompt(question, "") : "";
    if (note === null) { reply(null); return; }
    reply({ ...captureNoteTarget(branchNoteTarget), kind: message.kind, note: note.slice(0, 2000) });
  });
}
