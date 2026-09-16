// Settings → Using your screen and keyboard: the switch that has to be on before Branch may look
// at this computer's screen or work its windows, and how much it may do in one go.
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

const status = (message) => { $("desktop-status").textContent = message; };

function show(settings) {
  $("desktop-enabled").checked = Boolean(settings.enabled);
  $("desktop-cap").value = settings.maxActionsPerRun ?? 40;
  $("desktop-cap-row").hidden = !settings.enabled;
  $("desktop-off-note").hidden = Boolean(settings.enabled);
}

async function save(next) {
  try {
    show(await api("desktop/settings", next));
    status(next.enabled === false ? "Switched off. Branch can no longer see your screen." : "Saved.");
  } catch (e) {
    status(e.message);
  }
}

async function render() {
  try {
    show(await api("desktop/settings"));
  } catch (e) {
    status(e.message);
  }
}

$("desktop-enabled").addEventListener("change", (event) => void save({ enabled: event.target.checked }));
$("desktop-cap-save").addEventListener("click", () =>
  void save({ maxActionsPerRun: Math.max(1, Math.min(200, Number($("desktop-cap").value) || 40)) }));
window.branchDesktop = { render };
