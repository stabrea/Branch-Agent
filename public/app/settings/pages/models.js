import { esc } from "../../core/dom.js";
import { ic } from "../../core/ui.js";

export function draw() {
  return `<h1>Models</h1>
    <p class="lede">Which models answer, and where they run.</p>
    <div class="sec"><h2>Connections</h2>
      <p class="hint">Sign in on their site to connect your accounts.</p>
      <div class="grid2">
        <div class="tile"><b>Claude</b><p>Signed in</p><div class="acts"><span class="pill done" data-css="margin-left:auto"><i></i>Connected</span></div></div>
        <div class="tile"><b>ChatGPT</b><p>Not signed in</p><div class="acts"><button class="btn sm" type="button" data-act="toast" data-msg="Sign in on their site.">Sign in</button></div></div>
      </div>
    </div>
    <div class="sec"><h2>Defaults</h2>
      <div class="ctl"><b>Most conversations</b><span class="right"><select class="inp" data-sw="model-default" data-css="width:160px"><option>Claude</option><option>ChatGPT</option></select></span><small>The model Trunks use first.</small></div>
    </div>`;
}

export function init() {}
