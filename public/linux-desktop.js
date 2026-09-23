// Settings → Computer & browser → Shared Linux desktop (FQ-execution.desktop): the switch, the image a
// desktop starts from, and the owner's own Take over and Hand back. Handing back lives only here (and
// behind the owner's route), so the assistant can never give the desktop back to itself.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
/** The chosen language's words for a key, or the English given here when the key has none. */
const say = (key, english) => { const words = t(key); return words === key ? english : words; };

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

const status = (message) => { $("linux-desktop-status").textContent = message; };

/** What is going on right now, in one line. */
function stateLine(state) {
  if (!state.running) return say("linux-desktop.state.not-running", "No shared desktop is running.");
  if (state.control === "user") return say("linux-desktop.state.yours", "You hold the shared desktop. Branch cannot act in it until you hand it back.");
  return say("linux-desktop.state.branch", "Branch is using the shared desktop. You can take it over at any time.");
}

let imageTouched = false;
function show(state) {
  const mode = $("linux-desktop-mode");
  if (document.activeElement !== mode) mode.value = state.mode;
  if (!imageTouched) $("linux-desktop-image").value = state.image ?? "";
  $("linux-desktop-state").textContent = stateLine(state);
  $("linux-desktop-control-row").hidden = !state.running;
  $("linux-desktop-take-over").hidden = state.control !== "agent";
  $("linux-desktop-hand-back").hidden = state.control !== "user";
}

async function send(path, body, done) {
  try {
    show(await api(path, body));
    status(done);
  } catch (e) {
    status(e.message);
  }
}

async function render() {
  try {
    show(await api("linux-desktop"));
  } catch (e) {
    status(e.message);
  }
}

$("linux-desktop-mode").addEventListener("change", (event) => void send("linux-desktop", { mode: event.target.value },
  event.target.value === "off" ? say("linux-desktop.status.off", "Switched off. Any shared desktop was taken down.") : say("linux-desktop.status.saved", "Saved.")));
$("linux-desktop-image").addEventListener("input", () => { imageTouched = true; });
$("linux-desktop-image-save").addEventListener("click", () => {
  imageTouched = false;
  void send("linux-desktop", { image: $("linux-desktop-image").value.trim() }, say("linux-desktop.status.saved", "Saved."));
});
$("linux-desktop-take-over").addEventListener("click", () =>
  void send("linux-desktop/take-over", {}, say("linux-desktop.status.taken-over", "It is yours. Branch has let go of it.")));
$("linux-desktop-hand-back").addEventListener("click", () =>
  void send("linux-desktop/hand-back", {}, say("linux-desktop.status.handed-back", "Handed back to Branch.")));

window.branchLinuxDesktop = { render };
