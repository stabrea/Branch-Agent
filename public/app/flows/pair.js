/* Phone pairing: QR code and instructions for pairing a phone with Branch. */

import { esc, applyCss } from "../core/dom.js";
import { openDlg, closeDlg } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

/* Phone pairing is the phone app's (design doc A.15); there is no computer-side pairing screen yet, so "pair" stays
   greyed out rather than drawing a code that pairs nothing. */
export function init() {}

function pairPhone() {
  const html = `<div data-css="text-align:center;padding:16px">
    <canvas class="qr" width="148" height="148" data-css="border:1px solid var(--line);display:block;margin:0 auto 16px;background:white;border-radius:8px" aria-label="QR code for pairing"></canvas>
    <ol data-css="text-align:left;margin:16px 0;padding:0 16px;list-style-position:inside">
      <li>Open the Branch app on your phone.</li>
      <li>Tap <b>Pair with a computer</b>.</li>
      <li>Point the camera at this code.</li>
      <li>Check that both screens show the same code.</li>
    </ol>
    <p data-css="color:var(--ink-3);font-size:13px;margin-top:16px">The code works once and expires in 5 minutes.</p>
  </div>`;

  openDlg({
    title: "Pair a phone",
    body: html,
    foot: '<button class="btn pri" data-act="dlg-close">Close</button>'
  });

  const canvas = document.querySelector(".qr");
  if (canvas) drawQRPlaceholder(canvas);
}

function drawQRPlaceholder(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 148, 148);
  ctx.fillStyle = "black";
  for (let i = 0; i < 1000; i++) {
    const x = Math.floor(Math.random() * 148);
    const y = Math.floor(Math.random() * 148);
    ctx.fillRect(x, y, 1, 1);
  }
}
