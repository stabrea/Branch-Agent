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
  } catch (error) { say("embeds-status", error.message); }
}
$("embeds-save")?.addEventListener("click", async () => {
  try {
    const widgetSites = $("embed-sites").value.split("\n").map((line) => line.trim()).filter(Boolean);
    await api("embeds", { widget: $("embed-widget").checked, extension: $("embed-extension").checked, widgetSites });
    say("embeds-status", t("embeds.saved"));
  } catch (error) { say("embeds-status", error.message); }
});

document.querySelector('[data-view="settings"]')?.addEventListener("click", () => {
  void drawObsidian();
  void drawEmbeds();
});
await drawObsidian();
await drawEmbeds();
