import { esc } from "../../core/dom.js";
import { ctlSeg } from "../parts.js";

export function draw() {
  const cur = document.documentElement.dataset.theme || "system";
  const size = document.documentElement.dataset.size || "Regular";

  return `<h1>Appearance</h1>
    <p class="lede">How Branch looks on this computer.</p>
    <div class="sec"><h2>Light or dark</h2>
      <div class="ctl"><span class="right"><span class="seg" role="group" aria-label="Light or dark">${[
        ["light", "Light"],
        ["dark", "Dark"],
        ["system", "Match this computer"]
      ]
        .map(
          ([v, l]) =>
            `<button type="button" data-act="themeset" data-v="${v}" aria-pressed="${cur === v}">${esc(l)}</button>`
        )
        .join("")}</span></span></div>
    </div>
    <div class="sec"><h2>Reading</h2>
      <div class="ctl"><b>Text size</b><span class="right"><span class="seg" role="group" aria-label="Text size">${[
        ["small", "Small"],
        ["Regular", "Regular"],
        ["large", "Large"]
      ]
        .map(
          ([v, l]) =>
            `<button type="button" aria-pressed="${size === (v === "Regular" ? "Regular" : v)}" data-act="size" data-v="${v}">${esc(l === "Regular" ? "Regular" : l)}</button>`
        )
        .join("")}</span></span><small>Changes every screen.</small></div>
    </div>
    <div class="sec"><h2>Extras</h2>
      <div class="ctl"><b>Reduced motion</b><input class="sw" type="checkbox" id="a-still" aria-label="Reduced motion" data-sw="still"><small>Stops animations and movement.</small></div>
    </div>`;
}

export function init() {}
