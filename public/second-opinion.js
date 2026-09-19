/**
 * The second-opinion card in Settings: whether a second connection checks each finished answer,
 * which connection that is, and the two bounds a debate is held inside. It only reads and writes
 * the saved settings; the advice itself is shown beside the answer on the task, not here.
 */
import { api } from "/app.js";

const $ = (id) => document.getElementById(id);

/** Adds the owner's model connections after the "whichever one answered" choice already in the page. */
function fillConnections(select, presets, chosen) {
  for (const option of [...select.options]) if (option.value) option.remove();
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.name} (${preset.provider})`;
    select.append(option);
  }
  select.value = presets.some((preset) => preset.id === chosen) ? chosen : "";
}

async function load() {
  if (!$("second-opinion-form")) return;
  const [settings, state] = await Promise.all([api("second-opinion"), api("state")]);
  $("advisor-on").checked = Boolean(settings.advisor);
  $("advisor-ceiling").value = settings.advisorMaxTokens;
  $("debate-exchanges").value = settings.debateExchanges;
  $("debate-ceiling").value = settings.debateMaxTokens;
  fillConnections($("advisor-preset"), state.models?.presets ?? [], settings.advisorPreset ?? "");
}

async function save(event) {
  event.preventDefault();
  await api("second-opinion", {
    advisor: $("advisor-on").checked,
    advisorPreset: $("advisor-preset").value || null,
    advisorMaxTokens: Number($("advisor-ceiling").value),
    debateExchanges: Number($("debate-exchanges").value),
    debateMaxTokens: Number($("debate-ceiling").value),
  });
  await load();
}

$("second-opinion-form")?.addEventListener("submit", save);
/* Settings that will not load leave the card as it is rather than breaking the rest of the page. */
load().catch(() => {});
// phase2/settings: the page signs in after this first try, so read the saved values when Settings opens
// (an empty box here was saved as 0).
document.addEventListener("branch-place", (event) => {
  if (String(event.detail?.view ?? "").startsWith("settings")) load().catch(() => {});
});
