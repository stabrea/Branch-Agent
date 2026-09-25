/* Settings › achievements: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { renderNow } from "../../core/dom.js";

let achievements = { total: 505, unlocked: 0, tiers: {}, list: [] };

async function loadAchievements() {
  try {
    const data = await api("delight/achievements");
    achievements = data || { total: 505, unlocked: 0, tiers: {}, list: [] };
  } catch (e) {
    console.error("Failed to load achievements:", e);
    achievements = { total: 505, unlocked: 0, tiers: {}, list: [] };
  }
  renderNow();
}

export function init() {
  loadAchievements();
}

function draw() {
  const t = achievements.tiers || {};
  const unlockedCount = achievements.unlocked || 0;
  const totalCount = achievements.total || 505;

  let html = "<h1>Achievements</h1>";
  html += "<p class=\"lede\">Private to you, never nagging. " + unlockedCount + " of " + totalCount + " unlocked.</p>";

  html += "<div class=\"ach-sum\">";
  html += "<span class=\"tierc\"><i data-css=\"background:#A86A3D\"></i>Bronze · " + (t.bronze || "0") + "/100</span>";
  html += "<span class=\"tierc\"><i data-css=\"background:#8C959E\"></i>Silver · " + (t.silver || "0") + "/100</span>";
  html += "<span class=\"tierc\"><i data-css=\"background:#C9982E\"></i>Gold · " + (t.gold || "0") + "/100</span>";
  html += "<span class=\"tierc\"><i data-css=\"background:#4F8FB8\"></i>Diamond · " + (t.diamond || "0") + "/100</span>";
  html += "<span class=\"tierc\"><i data-css=\"background:#8A5AA8\"></i>Godly · " + (t.godly || "0") + "/100</span>";
  html += "<span class=\"tierc\"><i data-css=\"background:#C2412D\"></i>SSS+ · " + (t.sss || "0") + "/5</span>";
  html += "</div>";

  html += "<div class=\"tabs\" role=\"tablist\" data-css=\"margin-top:6px\">";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"true\" data-act=\"achcat\" data-v=\"All\">All</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Getting started\">Getting started</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Trunks &amp; devices\">Trunks &amp; devices</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Automations\">Automations</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Looks &amp; fun\">Looks &amp; fun</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Streaks\">Streaks</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Safety\">Safety</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Explorer\">Explorer</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Secrets\">Secrets</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Look\">Look</button>";
  html += "<button class=\"tab\" role=\"tab\" type=\"button\" aria-selected=\"false\" data-act=\"achcat\" data-v=\"Setup\">Setup</button>";
  html += "</div>";

  html += "<div class=\"sec\"><h2>Settings</h2>";
  html += "<div class=\"ctl\"><b>Keep achievements quiet</b>";
  html += "<input class=\"sw\" type=\"checkbox\" id=\"ach-q\" " + (E.state?.achQuiet ? "checked" : "") + " aria-label=\"Keep achievements quiet\" data-sw=\"ach-q\">";
  html += "<small>No pop-ups. They still unlock. Bronze and Silver pop small for 7 seconds; Gold and up get the big one with confetti.</small>";
  html += "</div>";
  html += "<p class=\"hint\">Hints: Bronze and Silver get a pet hint at most once an hour; Gold and up get none.</p>";
  html += "</div>";

  return html;
}

export async function load() {
  await loadAchievements();
}

export const live = {
  // Wire up controls to real routes
};
