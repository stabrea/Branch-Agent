// Provider selection UI for model connection form
// Fetches catalog from GET /api/providers/catalog
// Calls POST /api/providers/test to validate connections
// Calls GET /api/providers/local to probe for local runtimes

import { $, toast } from "./app.js";
import { t } from "./i18n.js";

const standingKeys = {
  official: "terms.standing.official",
  unofficial: "terms.standing.unofficial",
  retired: "terms.standing.retired",
  "not-offered": "terms.standing.not-offered",
};

/** The Terms line for one provider: the route used, its standing, any warning, and the terms link. */
export function showTerms(preset) {
  const line = $("provider-terms");
  if (!line) return;
  const terms = preset?.terms;
  line.hidden = !terms;
  if (!terms) return;
  line.dataset.standing = terms.standing;
  $("provider-terms-route").textContent = terms.route + ".";
  $("provider-terms-standing").textContent = t(standingKeys[terms.standing] ?? standingKeys.official);
  $("provider-terms-warning").textContent = terms.warning ?? "";
  const link = $("provider-terms-link");
  link.href = /^https:\/\//.test(terms.url) ? terms.url : "#";
}

export async function initProvidersUI() {
  const dropdown = $("provider-preset");
  const testBtn = $("provider-test");
  const localBtn = $("provider-local");

  if (!dropdown || !testBtn || !localBtn) return;

  // Load presets catalog
  let presets = [];
  try {
    const res = await fetch("/api/providers/catalog", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      presets = data.presets || [];
    }
  } catch (e) {
    console.error("Failed to load provider catalog:", e);
  }

  // Populate dropdown
  dropdown.innerHTML = `<option value="">${t("models.custom-address", "Another web address")}</option>`;
  for (const preset of presets) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    const standing = preset.terms?.standing;
    opt.textContent = standing && standing !== "official"
      ? `${preset.displayName} (${t(standingKeys[standing])})` : preset.displayName;
    dropdown.appendChild(opt);
  }

  // On preset selection, fill endpoint, show help, suggest models
  dropdown.addEventListener("change", () => {
    const presetId = dropdown.value;
    showTerms(presets.find((p) => p.id === presetId));
    if (!presetId) {
      $("model-settings-note").textContent = "";
      $("provider-model-suggestions").innerHTML = "";
      return;
    }

    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;

    $("model-endpoint").value = preset.baseUrl;
    $("model-settings-note").textContent = preset.keyHelp;

    const suggestions = $("provider-model-suggestions");
    suggestions.innerHTML = "";
    for (const model of preset.modelIds) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      suggestions.appendChild(opt);
    }
  });

  // Test connection button
  testBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    const presetId = dropdown.value;
    const endpoint = $("model-endpoint").value;
    const model = $("model-name").value;
    const apiKey = $("model-key").value;

    if (!model || !apiKey) {
      toast("Enter a model and API key to test");
      return;
    }

    testBtn.disabled = true;
    try {
      const body = presetId
        ? { preset: presetId, model: model || undefined, apiKey: apiKey || undefined }
        : { endpoint, model, apiKey };

      const res = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });

      if (res.ok) {
        const result = await res.json();
        toast(`Connected to ${result.provider}: ${result.reply.slice(0, 40)}`);
      } else {
        const error = await res.json();
        toast(`Connection failed: ${error.message || res.statusText}`);
      }
    } catch (e) {
      toast(`Error: ${e.message}`);
    } finally {
      testBtn.disabled = false;
    }
  });

  // Local runtime detection button
  localBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    localBtn.disabled = true;
    try {
      const res = await fetch("/api/providers/local", { credentials: "same-origin" });
      if (!res.ok) throw new Error(res.statusText);

      const data = await res.json();
      const locals = data.local || [];

      if (!locals.length) {
        toast("No local model servers found. Start Ollama or LM Studio and try again.");
        return;
      }

      const runtime = locals[0];
      $("model-endpoint").value = runtime.baseUrl;
      $("model-name").value = runtime.models[0] || "";

      const suggestions = $("provider-model-suggestions");
      suggestions.innerHTML = "";
      for (const model of runtime.models) {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        suggestions.appendChild(opt);
      }

      toast(`Found ${runtime.runtime}: ${runtime.models.length} model(s)`);
    } catch (e) {
      toast(`Error detecting local runtimes: ${e.message}`);
    } finally {
      localBtn.disabled = false;
    }
  });
}
