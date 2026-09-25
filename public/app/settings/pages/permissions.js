import { esc } from "../../core/dom.js";
import { ctl, statusBox } from "../parts.js";

export function draw() {
  return `<h1>Permissions</h1>
    <p class="lede">What Trunks may do without asking you first.</p>
    ${statusBox("Ask first is on", "Trunks ask before they send, delete, spend money or install anything.", false)}
    <div class="sec"><h2>Without asking, Trunks may…</h2>
      ${ctl("p-read", "Read files in Documents and Downloads", "Reading never changes a file.", true)}
      ${ctl("p-browse", "Use the browser on this computer", "Signs in with your saved sign-ins. You can take over any time.", true)}
      ${ctl("p-send", "Send email and messages", "Off means every message waits for your yes.", false)}
      ${ctl("p-install", "Install tools and packages", "Off means a request shows up in your Inbox.", false)}
      ${ctl("p-record", "Record tasks so you can watch them again", "Recordings stay on this computer.", true)}
    </div>
    <div class="sec"><h2>Sensitive tools</h2>
      <div class="ctl"><b>Authenticator code</b><input class="sw" type="checkbox" id="p-auth" aria-label="Authenticator code" data-sw="set"><small>Required for tools that change money or access.</small></div>
    </div>
    <div class="danger"><div><b>Lockdown</b><p>One switch that stops every Trunk from sending, changing or spending anything.</p></div><button class="btn" type="button" data-act="lock">Turn Lockdown on</button></div>
    <div id="perm-mount"></div>`;
}

export function init() {}
