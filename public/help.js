/**
 * Help, in the app. "Help" in the owner's menu opens the handbook chapter for the section you are
 * looking at, in the pane on the right, through the same Markdown renderer every reply uses. The
 * Ctrl+K box gets one "Help: <chapter>" line per chapter, so any of them can be opened by name.
 *
 * Reading only: this file fetches `GET /api/help/<chapter>` and draws what comes back. It changes
 * nothing, asks for no permission and sends nothing.
 */
import { api } from "/app.js";

let chapters = [];

/** Which chapter answers questions about the section on screen. */
export function chapterFor(view) {
  return chapters.find((chapter) => chapter.views.includes(view)) ?? chapters[0];
}

/**
 * The chapter list, fetched once. It cannot be fetched before the session key is in hand, so this
 * is called when something first needs it rather than when the file loads.
 */
async function loadChapters() {
  if (chapters.length) return chapters;
  chapters = (await api("help")).chapters;
  return chapters;
}

const $ = (id) => document.getElementById(id);

/** Opens one chapter in the pane on the right and unfolds the pane if it was away. */
export async function openHelp(id) {
  const panel = $("context-help");
  const body = $("context-help-body");
  if (!panel || !body) return;
  const { renderMarkdown } = await import("/markdown.js");
  body.replaceChildren(document.createTextNode("Opening…"));
  panel.hidden = false;
  document.body.classList.remove("no-aside");
  const chapter = await api(`help/${id}`);
  $("context-help-title").textContent = chapter.title;
  panel.dataset.chapter = chapter.id;
  body.className = "markdown context-help-body";
  body.replaceChildren(renderMarkdown(chapter.markdown));
  $("context-help-close")?.focus();
}

/** Help for the section that is open right now. */
export async function openHelpForCurrentView() {
  await loadChapters();
  /* Inside a place (public/layout.js) the open tab is the old section, so its chapter still matches. */
  const shown = (node) => !node.hidden && node.offsetParent !== null;
  const open = [...document.querySelectorAll(".lx-panel")].find(shown) ?? [...document.querySelectorAll(".view")].find(shown);
  await openHelp(chapterFor(open?.id ?? "chat").id);
}

/** One "Help: <chapter>" line per chapter, for the Ctrl+K box. */
export function helpEntries() {
  return chapters.map((chapter) => ({
    label: `Help: ${chapter.title}`,
    hint: "Help",
    run: () => void openHelp(chapter.id),
  }));
}

$("menu-help")?.addEventListener("click", () => void openHelpForCurrentView());
$("context-help-close")?.addEventListener("click", () => {
  const panel = $("context-help");
  if (panel) panel.hidden = true;
});
globalThis.branchHelp = {
  openHelp,
  openHelpForCurrentView,
  helpEntries,
  chapterFor,
  /** The Ctrl+K box calls this and redraws itself, because the list may not be in hand yet. */
  ready: () => loadChapters().catch(() => chapters),
};
