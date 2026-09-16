/**
 * Wave 6 boot: choose the language before anything else draws, then bring in the "Look inside"
 * panel, the live row, the context meter and the developer playground. Last of all, the phone bits:
 * the app can be kept on the home screen and opens from a cached copy of its own files, with a
 * clear banner when there is no way back to your computer. Inside the desktop app none of that
 * applies, so it is skipped.
 */
import { LANGUAGES, applyLanguage, initLanguage, language, setLanguage, t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const desktop = new URLSearchParams(location.search).get("desktop") === "1" || Boolean(globalThis.branchDesktop);

/** The language picker in Appearance; the choice is this browser's, not the workspace's. */
function wireLanguagePicker() {
  const picker = $("appearance-language");
  if (!picker) return;
  picker.replaceChildren();
  for (const entry of LANGUAGES) picker.append(new Option(entry.label, entry.id));
  picker.value = language();
  picker.addEventListener("change", (event) => void setLanguage(event.target.value));
}
/* New rows drawn after the page loaded carry the same marks, so translate them too. */
function watchForNewText() {
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node.nodeType === 1 && (node.dataset?.t || node.querySelector?.("[data-t]"))) { applyLanguage(node.parentNode ?? document); return; }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
/** Says plainly when the computer cannot be reached, instead of letting buttons fail quietly. */
function wireOfflineBanner() {
  const banner = $("offline-banner");
  const show = () => { banner.hidden = navigator.onLine; };
  addEventListener("online", show);
  addEventListener("offline", show);
  show();
}
/**
 * Keeps the app's own files for the phone. Never inside the desktop app: it already has its files,
 * and a worker there would only get in the way of the updater.
 */
function registerServiceWorker() {
  /* This module runs after the page is built, so there is nothing left to wait for. */
  if (desktop || !("serviceWorker" in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {
    /* Without a worker the app still works; it just is not installable. */
  });
}
/** The browser's own "install this" prompt, offered once from the owner menu. */
function wireInstallPrompt() {
  if (desktop) return;
  let prompt = null;
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prompt = event;
    const menu = $("owner-menu");
    if (!menu || menu.querySelector("#install-app")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "install-app";
    button.setAttribute("role", "menuitem");
    button.dataset.t = "pwa.install";
    button.textContent = t("pwa.install");
    button.addEventListener("click", async () => { await prompt?.prompt(); button.remove(); });
    menu.prepend(button);
  });
}

await initLanguage();
applyLanguage();
wireLanguagePicker();
watchForNewText();
document.addEventListener("branch-language", () => wireLanguagePicker());
/* These four draw into markup that is already on the page, so they load after the words are set. */
await Promise.all([
  import("./inspector.js"),
  import("./live-run.js"),
  import("./token-meter.js"),
  import("./playground.js").then((module) => {
    $("playground")?.addEventListener("toggle", () => void module.renderPlayground());
  }),
]);
wireOfflineBanner();
registerServiceWorker();
wireInstallPrompt();
