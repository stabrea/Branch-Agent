// "How Branch runs on this computer": start with Windows, keep working with the window closed,
// reach Branch from a phone, and the safety copies taken before an update.
import { t } from "./i18n.js"; // relative, so a test can import this file too; the same /i18n.js in the page

/** Which system the person signs in to, from the platform Branch itself runs on (not the viewer's). */
export const signInSystem = (platform) => (platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "computer");
/** The label key for that system: the plain key says "this computer", `.windows` and `.mac` name it. */
export const signInKey = (key, platform) => (signInSystem(platform) === "computer" ? key : `${key}.${signInSystem(platform)}`);
const signInPlace = { windows: "Windows", mac: "your Mac", computer: "this computer" };
/** "Branch will open when you sign in to …", for the status lines under the switches. */
export const opensWhenSignedIn = (platform, quietly = false) =>
  `Branch will open${quietly ? " quietly" : ""} when you sign in to ${signInPlace[signInSystem(platform)]}.`;
const signInLabels = ["field.open-branch-when-i-sign", "field.start-branch-when-i-sign"];

const card = typeof document === "undefined" ? null : document.getElementById("deployment-card");
if (card) {
  let platform = "";
  const token = () => sessionStorage.getItem("branch-token") || "";
  const desktop = new URLSearchParams(location.search).get("desktop") === "1";
  const pick = (id) => document.getElementById(id);

  async function call(path, body) {
    const response = await fetch("/api/deployment" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined
        ? { authorization: "Bearer " + token() }
        : { authorization: "Bearer " + token(), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "That did not work.");
    return value;
  }
  function say(id, text, bad) {
    const node = pick(id);
    node.textContent = text;
    node.classList.toggle("bad", Boolean(bad));
  }
  function drawQr(matrix) {
    const canvas = pick("phone-qr");
    const quiet = 4, scale = Math.max(2, Math.floor(240 / (matrix.size + quiet * 2)));
    canvas.width = canvas.height = (matrix.size + quiet * 2) * scale;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#ffffff";
    paint.fillRect(0, 0, canvas.width, canvas.height);
    paint.fillStyle = "#000000";
    matrix.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++)
        if (row[x] === "1") paint.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    });
    canvas.hidden = false;
  }
  /** The two "Open Branch when I sign in to …" labels name the system this Branch runs on. */
  function nameTheSystem() {
    for (const key of signInLabels)
      for (const node of document.querySelectorAll(`[data-t^="${key}"]`)) {
        node.dataset.t = signInKey(key, platform);
        // Before the words have loaded, t() answers with the key itself: keep the page's own words then
        // (applyLanguage writes the right ones when they arrive, since data-t already names them).
        const word = t(node.dataset.t);
        if (word !== node.dataset.t) node.textContent = word;
      }
  }
  function render(state) {
    platform = state.platform ?? "";
    nameTheSystem();
    pick("start-with-windows").checked = state.autostart.enabled;
    pick("start-minimised").checked = state.autostart.minimized;
    pick("keep-running").checked = state.daemon.installed;
    say("keep-running-status", state.daemon.message);
    pick("phone-switch").checked = state.remote.enabled;
    say("phone-status", state.remote.message);
    pick("phone-invite").hidden = !state.remote.enabled;
    const points = pick("restore-points");
    points.textContent = state.restorePoints.length
      ? `Safety copies kept: ${state.restorePoints.map((p) => `${p.version} (${p.savedAt.slice(0, 10)})`).join(", ")}.`
      : "No safety copy has been taken yet. One is taken automatically before each update.";
    const unhealthy = state.firstStart && !state.firstStart.healthy && state.firstStart.previousVersion;
    pick("restore-offer").hidden = !(unhealthy && state.restorePoints.length);
    if (unhealthy && state.restorePoints.length)
      say("restore-offer-note", `Version ${state.firstStart.version} did not start cleanly. You can put back the saved work from just before the update to ${state.firstStart.version}.`);
    if (!state.installed) say("deployment-note", "These switches need Branch installed on this computer. They do nothing while it runs from a folder of source code.");
  }
  async function refresh() {
    try { render(await call("")); } catch (error) { say("deployment-note", error.message, true); }
  }
  pick("start-with-windows").addEventListener("change", async (event) => {
    try {
      await call("/autostart", { enabled: event.target.checked, minimized: pick("start-minimised").checked });
      say("start-with-windows-status", event.target.checked
        ? opensWhenSignedIn(platform)
        : "Branch will not open by itself.");
    } catch (error) { event.target.checked = !event.target.checked; say("start-with-windows-status", error.message, true); }
  });
  pick("start-minimised").addEventListener("change", async () => {
    if (!pick("start-with-windows").checked) return;
    try { await call("/autostart", { enabled: true, minimized: pick("start-minimised").checked }); }
    catch (error) { say("start-with-windows-status", error.message, true); }
  });
  pick("keep-running").addEventListener("change", async (event) => {
    try {
      const report = await call("/daemon", { action: event.target.checked ? "install" : "uninstall" });
      say("keep-running-status", report.message);
    } catch (error) { event.target.checked = !event.target.checked; say("keep-running-status", error.message, true); }
  });
  pick("phone-switch").addEventListener("change", async (event) => {
    try {
      const status = await call("/remote", { enabled: event.target.checked });
      say("phone-status", status.message);
      pick("phone-invite").hidden = !status.enabled;
      if (!status.enabled) { pick("phone-qr").hidden = true; say("phone-code", ""); }
    } catch (error) { event.target.checked = false; say("phone-status", error.message, true); }
  });
  pick("phone-invite").addEventListener("click", async () => {
    try {
      const invitation = await call("/remote/invite", {});
      drawQr(invitation.qr);
      say("phone-code", `Point your phone's camera at the square, then type ${invitation.code} on the phone. Or open ${invitation.url} by hand.`);
    } catch (error) { say("phone-code", error.message, true); }
  });
  pick("restore-previous").addEventListener("click", async () => {
    try {
      const points = await call("/restore-points");
      const newest = points.points[0];
      if (!newest) throw new Error("There is no safety copy to put back.");
      // Putting a copy back writes over the conversations, memory and skills that are here now.
      const sure = confirm(`This replaces everything saved here with the copy from ${newest.savedAt.slice(0, 10)} (version ${newest.version}). Anything added since then is lost. Put it back?`);
      if (!sure) { say("restore-offer-note", "Left as it is. Nothing was changed."); return; }
      const result = await call("/restore-point", { name: newest.name });
      say("restore-offer-note", `Put back ${result.rows} saved items from ${newest.version}. Close and open Branch to see them.`);
    } catch (error) { say("restore-offer-note", error.message, true); }
  });
  pick("run-doctor").addEventListener("click", async () => {
    say("doctor-report", "Checking…");
    try {
      const report = await call("/doctor?fix=1");
      pick("doctor-report").textContent = report.checks
        .map((check) => `${check.ok ? "OK" : "Needs attention"} — ${check.name}: ${check.summary}${check.fix ? " " + check.fix : ""}`)
        .join("\n");
    } catch (error) { say("doctor-report", error.message, true); }
  });
  // The same two switches on the first-run checklist, where a new owner meets them first.
  const firstRunAutostart = pick("first-run-autostart"), firstRunPhone = pick("first-run-phone");
  if (firstRunAutostart)
    firstRunAutostart.addEventListener("change", async (event) => {
      try {
        await call("/autostart", { enabled: event.target.checked, minimized: true });
        pick("start-with-windows").checked = event.target.checked;
        say("first-run-extras-status", event.target.checked
          ? opensWhenSignedIn(platform, true)
          : "Branch will not open by itself.");
      } catch (error) { event.target.checked = false; say("first-run-extras-status", error.message, true); }
    });
  if (firstRunPhone)
    firstRunPhone.addEventListener("change", async (event) => {
      try {
        const status = await call("/remote", { enabled: event.target.checked });
        pick("phone-switch").checked = status.enabled;
        pick("phone-invite").hidden = !status.enabled;
        say("first-run-extras-status", status.enabled
          ? "Switched on. Open Settings to show the square code your phone scans."
          : status.message);
      } catch (error) { event.target.checked = false; say("first-run-extras-status", error.message, true); }
    });
  if (token() || desktop) void refresh();
}
