/* Computer & browser stage view (A.5): full-size overlay showing a task's screen or browser.
   Window state: which computer/browser the stage shows (S.stageMode, S.compFor, S.stageGrid).
   Engine routes: GET /api/runs/{id}/recording (frames), POST /api/runs/{id}/cancel (stop).
   Engine read-only: GET /api/linux-desktop (take-over button), GET /api/reach/machines. */

import { $, esc, applyCss, render, onRender } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";

/* Initialize stage state: stageMode (off/computer/browser), compFor (which conversation), stageGrid, stageGap (dock on/off), stagePip */
S.stageMode ??= "off";
S.stageGrid ??= false;
S.stageGap ??= true;
S.stagePip ??= false;
S.stageStep ??= null;

export function initStage() {
  markLive(["stage", "stage-close", "stage-dock", "stage-pip", "stage-stop", "stage-step", "br-take", "takeover", "machine", "comp-view", "comp-grid", "rc-save", "ph-stop8"]);
  onRender(drawStage);

  on("stage", (el) => {
    const mode = el.dataset.m;
    S.stageMode = S.stageMode === mode ? "off" : mode;
    S.compFor = null;
    render();
  });

  on("stage-close", () => {
    S.stageMode = "off";
    render();
  });

  on("stage-dock", () => {
    S.stageGap = !S.stageGap;
    render();
  });

  on("stage-pip", () => {
    S.stagePip = !S.stagePip;
    render();
  });

  on("stage-stop", async (el) => {
    const runId = el.closest("[data-runid]")?.dataset.runid;
    if (!runId) return;
    try {
      await api(`runs/${encodeURIComponent(runId)}/cancel`, { cancel: true }, "POST");
      render();
    } catch (e) { /* error shown by toast */ }
  });

  on("stage-step", (el) => {
    const step = el.dataset.step;
    if (step === "live") {
      S.stageStep = null;
    } else {
      S.stageStep = step;
    }
    render();
  });

  on("comp-grid", () => {
    S.stageGrid = !S.stageGrid;
    render();
  });

  on("comp-view", (el) => {
    S.compFor = el.dataset.id;
    render();
  });


  on("br-take", async (el) => {
    const taking = el.dataset.who === "agent";
    try {
      await api(taking ? "linux-desktop/take-over" : "linux-desktop/hand-back", {}, "POST");
      render();
    } catch (e) { /* error */ }
  });

  on("takeover", async () => {
    try {
      await api("linux-desktop/take-over", {}, "POST");
      render();
    } catch (e) { /* error */ }
  });

  on("rc-save", async (el) => {
    const machineId = el.dataset.id;
    const newName = el.dataset.name;
    if (!newName) return;
    try {
      await api("reach/machine-name", { name: newName }, "POST");
      render();
    } catch (e) { /* error */ }
  });

  on("machine", async (el) => {
    const machineId = el.dataset.id;
    try {
      await api(`reach/machines/look`, { id: machineId }, "POST");
      S.compFor = machineId;
      render();
    } catch (e) { /* error */ }
  });

  on("ph-stop8", async (el) => {
    run("stage-stop", el);
  });
}

/* Render the stage overlay or hide it */
export function drawStage() {
  const stage = $(".stage7");
  if (S.stageMode === "off") {
    if (stage) stage.remove();
    return;
  }

  const html = stageHtml();
  if (stage) {
    stage.innerHTML = html;
  } else {
    const overlay = document.createElement("div");
    overlay.className = "stage7";
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
  }
  applyCss($(".stage7"));
}

/* Build the full stage HTML */
function stageHtml() {
  const cls = S.stageGap ? "" : " nodock";
  const pipClass = S.stagePip ? " pip-active" : "";
  const screenHtml = screenRender();
  const dockHtml = S.stageGap ? dockRender() : "";
  const stepsHtml = stepsRender();

  return `
    <div class="st7-top">
      <button class="st7-back" type="button" data-act="stage-close">${ic("back")} Close</button>
      <div class="st7-title">
        <b>${S.stageMode === "computer" ? "Computer" : "Browser"}</b>
        <span class="st7-sub">${S.compFor ? `on ${esc(S.compFor)}` : ""}</span>
      </div>
      <div class="st7-sw">
        <button type="button" aria-pressed="${S.stageMode === "computer"}" data-act="stage" data-m="computer">Computer</button>
        <button type="button" aria-pressed="${S.stageMode === "browser"}" data-act="stage" data-m="browser">Browser</button>
      </div>
    </div>
    <div class="st7-body${cls}${pipClass}">
      <div class="st7-wrap">
        ${screenHtml}
      </div>
      ${dockHtml}
    </div>
    ${stepsHtml}
  `;
}

/* Render the screen/browser canvas */
function screenRender() {
  const running = E.state?.runs?.find((r) => r.status === "running");
  if (!running) return '<div class="blank7"><div class="i">${ic("camera")}</div><p>No active task</p></div>';

  // For now, show a placeholder screen
  // In a real implementation, this would stream frames from GET /api/runs/{id}/recording
  return `
    <div class="st7-screen">
      <canvas class="st7-scale" id="stage-canvas" width="1280" height="800"></canvas>
      <div class="st7-cap">Live screen</div>
    </div>
  `;
}

/* Render the right dock panel */
function dockRender() {
  const running = E.state?.runs?.find((r) => r.status === "running");
  if (!running) return "";

  return `
    <div class="st7-dock">
      <div class="dk7-h">
        <b>Plan</b>
        <small>Step 3 of 8</small>
      </div>
      <ul class="dk7-plan">
        <li class="done">${ic("check")} First step</li>
        <li class="now">${ic("spin")} Current step</li>
        <li>Next step</li>
      </ul>
      <div class="dk7-msgs">
        <div class="dk7-m">What should I do?</div>
        <div class="dk7-m me7">Check the files</div>
      </div>
      <form class="dk7-in" onsubmit="return false">
        <input type="text" placeholder="Send a message" />
        <button type="button" aria-label="Send">→</button>
      </form>
    </div>
  `;
}

/* Render the step chips at the bottom */
function stepsRender() {
  const running = E.state?.runs?.find((r) => r.status === "running");
  if (!running) return "";

  return `
    <div class="st7-steps">
      <button type="button" class="st7-chip live7" data-act="stage-step" data-step="live" aria-pressed="true">
        <em>●</em> Live
      </button>
      <button type="button" class="st7-chip" data-act="stage-step" data-step="1">
        <em>1</em>
      </button>
      <button type="button" class="st7-chip" data-act="stage-step" data-step="2">
        <em>2</em>
      </button>
      <button type="button" class="st7-chip now" data-act="stage-step" data-step="3">
        <em>3</em>
      </button>
      <button type="button" class="st7-chip live7" data-act="stage-stop" data-runid="${esc(running.id)}" data-css="margin-left:auto">
        ${ic("stop")} Stop
      </button>
    </div>
  `;
}
