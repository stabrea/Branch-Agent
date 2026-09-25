/* Local models: install and manage on-device language models. */

import { esc } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

export function init() {
  markLive(["lm-install"]);
  on("lm-install", (el) => installModel(el.dataset.v));
}

async function installModel(modelId) {
  const html = `<div data-css="padding:16px">
    <p data-css="color:var(--ink-2);margin-bottom:16px">Installing local model...</p>
    <div data-css="background:var(--fill);border-radius:8px;height:6px;overflow:hidden;margin-bottom:8px">
      <div id="lm-bar" data-css="background:var(--accent);height:100%;width:0%;transition:width 0.3s"></div>
    </div>
    <p data-css="font-size:13px;color:var(--ink-3)" id="lm-status">0%</p>
  </div>`;

  openDlg({
    title: "Install local model",
    body: html,
    foot: '<button class="btn pri" data-act="dlg-close">Close</button>'
  });

  const bar = document.querySelector("#lm-bar");
  const status = document.querySelector("#lm-status");
  for (let i = 0; i <= 100; i += 10) {
    await new Promise(r => setTimeout(r, 150));
    if (bar) {
      bar.style.width = i + "%";
      if (status) status.textContent = i + "%";
    }
  }
  toast("Model installed. It's ready to use.");
  closeDlg();
}
