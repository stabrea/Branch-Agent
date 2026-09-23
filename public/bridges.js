/**
 * The two Settings cards this batch adds: the owner's notes folder, and the two switches for
 * reaching Branch from a page or a browser of their own. Both are plain read-and-save cards; the
 * rules that make them safe live on the app's side, not here.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (id, message) => { const box = $(id); if (box) box.textContent = message; };

/** The notes folder, as it stands now. */
export async function drawObsidian() {
  if (!$("obsidian-enabled")) return;
  try {
    const saved = await api("obsidian");
    $("obsidian-enabled").checked = Boolean(saved.enabled);
    $("obsidian-vault").value = saved.vault ?? "";
    $("obsidian-folder").value = saved.folder ?? "Branch";
  } catch (error) { say("obsidian-status", error.message); }
}
$("obsidian-save")?.addEventListener("click", async () => {
  try {
    await api("obsidian", {
      enabled: $("obsidian-enabled").checked,
      vault: $("obsidian-vault").value.trim(),
      folder: $("obsidian-folder").value.trim() || "Branch",
    });
    say("obsidian-status", t("obsidian.saved"));
  } catch (error) { say("obsidian-status", error.message); }
});

/** The two switches for the small ask box and the browser extension. */
export async function drawEmbeds() {
  if (!$("embed-widget")) return;
  try {
    const saved = await api("embeds");
    $("embed-widget").checked = Boolean(saved.widget);
    $("embed-sites").value = (saved.widgetSites ?? []).join("\n");
    $("embed-extension").checked = Boolean(saved.extension);
    say("embeds-status", ""); // a refusal from before the key was in is not left on show
  } catch (error) { say("embeds-status", error.message); }
}
/* DG-025: each switch, and the list of pages once it is left, is kept the moment it changes, as the sample saves.
   A switch that will not save goes back to what is saved, and it says why. */
async function saveEmbeds() {
  try {
    const widgetSites = $("embed-sites").value.split("\n").map((line) => line.trim()).filter(Boolean);
    await api("embeds", { widget: $("embed-widget").checked, extension: $("embed-extension").checked, widgetSites });
    say("embeds-status", t("embeds.saved"));
  } catch (error) {
    const typed = $("embed-sites").value; // the switches go back; the list being written stays as typed
    await drawEmbeds();
    $("embed-sites").value = typed;
    say("embeds-status", error.message);
  }
}
for (const id of ["embed-widget", "embed-extension", "embed-sites"]) $(id)?.addEventListener("change", saveEmbeds);

document.querySelector('[data-view="settings"]')?.addEventListener("click", () => {
  void drawObsidian();
  void drawEmbeds();
});
// phase2/settings: the two cards live in Library › Documents and Settings › Chat apps & devices (DG-194), which open without that old button.
document.addEventListener("branch-place", (event) => {
  const view = String(event.detail?.view ?? "");
  if (view === "documents" || view === "library:documents") void drawObsidian();
  if (view === "settings:channels") void drawEmbeds();
});
await drawObsidian();
await drawEmbeds();
