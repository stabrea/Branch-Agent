import { esc } from "../../core/dom.js";
import { ctl, ctlSeg } from "../parts.js";

export function draw() {
  return `<h1>Voice</h1>
    <p class="lede">Talking to Branch and hearing it talk back.</p>
    <div class="sec"><h2>Talking</h2>
      ${ctlSeg("Listening", "Push to talk holds the key; wake word listens for \"Hey Branch\".", ["Off", "Push to talk", "Wake word"], "Push to talk")}
      <div class="ctl"><b>Push-to-talk key</b><span class="right"><kbd data-css="font-size:12px;padding:4px 8px">Right Ctrl</kbd></span><small>Hold it anywhere in Windows.</small></div>
    </div>
    <div class="sec"><h2>Speaking back</h2>
      ${ctlSeg("Voice", "Read replies out loud in this voice.", ["Off", "Oak"], "Oak")}
      ${ctl("v-dict", "Dictation in the message box", "The microphone button turns speech into text.", true)}
    </div>`;
}

export function init() {}
