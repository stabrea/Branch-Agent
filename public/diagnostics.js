import { t } from "./i18n.js";
/**
 * Settings → Diagnostics: the promise that nothing is sent anywhere, a folder the owner can save
 * and pass on by hand, and the switch for writing trace files a tracing viewer can open.
 */
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function saveBundle() {
  const status = $("diagnostics-status");
  status.textContent = t("diagnostics.status.writing");
  try {
    const bundle = await api("diagnostics/bundle", {});
    status.textContent = `Saved to ${bundle.folder} — ${bundle.files.length} files covering ${bundle.events} recent events. Read them before sharing.`;
  } catch (e) {
    status.textContent = t("diagnostics.status.writeFailed", { message: e.message });
  }
}

/** Set once the owner touches this card, so a background refresh never overwrites their work. */
let touched = false;

async function saveTrace() {
  const status = $("trace-status");
  touched = true;
  status.textContent = "Saving…";
  try {
    const value = await api("trace/settings", {
      enabled: $("trace-enabled").checked,
      folder: $("trace-folder").value.trim() || null,
    });
    $("trace-folder").value = value.folder ?? "";
    status.textContent = value.enabled
      ? `On. Each finished task is written to ${value.folder}.`
      : "Off. No trace files are written.";
  } catch (e) {
    status.textContent = e.message;
  }
}

/** Fills the card in from what is saved. Called whenever the Settings screen is shown. */
async function render() {
  if (touched || !$("trace-enabled") || !sessionStorage.getItem("branch-token")) return;
  try {
    const value = await api("trace/settings");
    $("trace-enabled").checked = value.enabled;
    $("trace-folder").value = value.folder ?? "";
    $("trace-status").textContent = value.enabled
      ? `On. Each finished task is written to ${value.folder}.`
      : "Off. No trace files are written.";
  } catch {
    /* The card still explains itself when the settings cannot be read. */
  }
}

$("diagnostics-save")?.addEventListener("click", () => void saveBundle());
$("trace-save")?.addEventListener("click", () => void saveTrace());
for (const id of ["trace-enabled", "trace-folder"])
  $(id)?.addEventListener("input", () => { touched = true; });
window.branchDiagnostics = { render };
