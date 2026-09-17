/**
 * Models on this computer: what this computer has, whether Ollama and LM Studio are running, and
 * the task routing rules. Setting a model up, what is loaded and what is downloaded are drawn by
 * `public/local-oneclick.js` inside the same card (wave mac5), which replaced the older list of
 * three sizes and the typed-name download here.
 */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);

function drawRouting(routing) {
  $("local-routing-enabled").checked = routing.enabled;
  $("local-routing-private").checked = routing.localForPrivate;
  $("local-routing-hard").checked = routing.cloudForHard;
  $("local-routing-ceiling").value = routing.costCeilingDollars;
}

function summarise(view) {
  const parts = [];
  parts.push(view.ollama.installed
    ? t("local.state.ollama-running", { version: view.ollama.version, count: view.ollama.models.length })
    : t("local.state.ollama-missing"));
  if (view.lmStudio.running) parts.push(t("local.state.lm-studio-running", { count: view.lmStudio.models.length }));
  if (view.lastError) parts.push(t("local.state.last-problem", { what: view.lastError.what }));
  return parts.join(" ");
}

async function draw() {
  let view;
  try { view = await api("local-models"); } catch (error) { $("local-models-state").textContent = error.message; return; }
  $("local-models-hardware").textContent = t("local.state.hardware", { summary: view.hardware.summary });
  $("local-models-state").textContent = summarise(view);
  drawRouting(view.routing);
}

if ($("local-models-card")) {
  $("local-routing-save").addEventListener("click", async () => {
    try {
      await api("local-models/routing", {
        enabled: $("local-routing-enabled").checked,
        localForPrivate: $("local-routing-private").checked,
        cloudForHard: $("local-routing-hard").checked,
        costCeilingDollars: Number($("local-routing-ceiling").value) || 0,
      });
      toast(t("local.oneclick.saved"));
      await draw();
    } catch (error) { toast(error.message); }
  });
  const signedIn = () => { try { return Boolean(sessionStorage.getItem("branch-token")); } catch { return false; } };
  if (signedIn()) void draw();
  document.addEventListener("branch-language", () => void draw());
  new IntersectionObserver((entries) => { if (signedIn() && entries.some((entry) => entry.isIntersecting)) void draw(); }).observe($("local-models-card"));
}
