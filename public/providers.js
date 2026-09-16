// Provider selection UI for model connection form
// Fetches catalog from GET /api/providers/catalog
// Calls POST /api/providers/test to validate connections
// Calls GET /api/providers/local to probe for local runtimes

import { $, toast } from "./app.js";

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
  dropdown.innerHTML = '<option value="">Custom endpoint</option>';
  for (const preset of presets) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.displayName;
    dropdown.appendChild(opt);
  }

  // On preset selection, fill endpoint, show help, suggest models
  dropdown.addEventListener("change", () => {
    const presetId = dropdown.value;
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
