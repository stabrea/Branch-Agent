/**
 * The phone app's own screens: connect to a Branch, unlock, and the few things only a phone does
 * (send from the share sheet, talk, notifications). Everything else is the owner's Branch window,
 * which the native side opens with the key it keeps. See docs/configuration.md, "Phone apps".
 */
import { applyLanguage, initLanguage } from "/i18n.js";
import { applyTheme, paintOak } from "/theme.js";
import { createVault } from "/vault.js";
import { $, phone, plugin, say, show, status } from "/phone-common.js";
import { pair, readAddress, scan, unlock } from "/phone-pair.js";
import { drawHome } from "/phone-home.js";
import { addFiles, drawShared, send, startTalking, stopTalking } from "/phone-send.js";

const AWAY_MS = 5 * 60_000;

async function route() {
  const session = await phone.vault.current();
  if (!session) { show("screen-pair"); return; }
  const { lock } = await phone.vault.switches();
  const away = Date.now() - Number((await plugin.lastSeen?.())?.at ?? 0);
  if (lock === "on" || (lock === "when-needed" && away > AWAY_MS)) { show("screen-lock"); return; }
  await openHome(session);
}
async function openHome(session = null) {
  const current = session ?? (await phone.vault.current());
  if (!current) { show("screen-pair"); return; }
  phone.shared = ((await plugin.takeShared?.())?.items ?? []).concat(phone.shared);
  drawShared();
  show("screen-home");
  const switches = await drawHome(current);
  if (!phone.shared.length) return;
  $("send-card").scrollIntoView();
  // "On" sends what was shared at once; "when needed" waits for a note and a tap.
  if (switches.share === "on") await send();
}
function wire() {
  $("scan").addEventListener("click", () => void scan());
  $("address").addEventListener("change", readAddress);
  $("pair").addEventListener("click", () => void pair(route));
  $("unlock").addEventListener("click", () => void unlock(openHome));
  $("open-branch").addEventListener("click", () => void plugin.openBranch({ at: "" }));
  for (const button of document.querySelectorAll("[data-go]"))
    button.addEventListener("click", () => void plugin.openBranch({ at: button.dataset.go }));
  $("send-files").addEventListener("change", (event) => void addFiles([...event.target.files]));
  $("send").addEventListener("click", () => void send());
  $("talk").addEventListener("pointerdown", () => void startTalking());
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) $("talk").addEventListener(type, stopTalking);
  $("forget").addEventListener("click", async () => { await phone.vault.forget(); show("screen-pair"); });
  document.addEventListener("branch-shared", () => void openHome());
}
async function boot() {
  await initLanguage().catch(() => "en");
  const look = applyTheme((await plugin?.look?.().catch(() => null)) ?? {});
  void paintOak(look.mode);
  applyLanguage();
  wire();
  if (!plugin) { show("screen-pair"); status("pair-status", say("phone.notInApp", "This page only works inside the Branch phone app."), true); return; }
  phone.vault = createVault(plugin);
  await route();
  document.body.dataset.ready = "true";
}
void boot();
