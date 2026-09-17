/* The theme Settings › Appearance shows is the same one `branch theme` sets in a terminal. This file
   keeps the two in step through /api/look: a theme, contrast or language picked here is saved with
   the workspace, and one picked in a terminal since this window last looked is chosen here the way a
   person would choose it, by pressing its tile. Nothing here draws or names a colour; the tiles and
   public/layout.js do all of that. */
import { setLanguage, language } from "/i18n.js";

const SEEN = "branch-look-seen";
const remember = {
  get: () => { try { return localStorage.getItem(SEEN) || ""; } catch { return ""; } },
  set: (value) => { try { localStorage.setItem(SEEN, value); } catch { /* a private window forgets */ } },
};
async function api(body) {
  const response = await fetch("/api/look", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error("The shared theme could not be read");
  return response.json();
}
const html = document.documentElement;
const contrastBox = () => document.getElementById("lx-contrast");

/** Chooses what the terminal chose, through the same controls a person would use. */
function adopt(look) {
  if (html.dataset.palette !== look.theme)
    document.querySelector(`#lx-theme-gallery .lx-tile[data-family="${CSS.escape(look.theme)}"]`)?.click();
  const box = contrastBox();
  if (box && box.checked !== (look.contrast === "more")) box.click();
  if (look.language !== "auto" && look.language !== language()) void setLanguage(look.language);
}
async function pull() {
  const look = await api();
  if (look.changedBy === "terminal" && look.changedAt > remember.get()) adopt(look);
  else if (!look.changedAt && html.dataset.palette && html.dataset.palette !== look.theme) await push({ theme: html.dataset.palette });
  remember.set(look.changedAt);
}
async function push(change) {
  const look = await api(change);
  remember.set(look.changedAt);
}
function watch() {
  let theme = html.dataset.palette;
  new MutationObserver(() => {
    if (html.dataset.palette === theme) return;
    theme = html.dataset.palette;
    void push({ theme }).catch(() => undefined);
  }).observe(html, { attributes: true, attributeFilter: ["data-palette"] });
  contrastBox()?.addEventListener("change", (event) => void push({ contrast: event.target.checked ? "more" : "standard" }).catch(() => undefined));
  document.addEventListener("branch-language", (event) => void push({ language: event.detail.language }).catch(() => undefined));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void pull().catch(() => undefined); });
}
function whenReady(start) {
  if (document.body.classList.contains("lx-ready")) return start();
  const wait = new MutationObserver(() => {
    if (!document.body.classList.contains("lx-ready")) return;
    wait.disconnect();
    start();
  });
  wait.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
whenReady(() => { void pull().catch(() => undefined).finally(watch); });
