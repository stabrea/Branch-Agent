/* Settings > permissions: bind Trunks' permissions. Mount Mac/Windows OS permissions module. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render } from "../../core/dom.js";
import { mountPermissions } from "../../mac/permissions.js";

const HEAD = `<h1>Permissions</h1><p class="lede">What Trunks may do without asking you first.</p><div id="perm-mount"></div>`;

const BASE_SWITCHES = `<div class="status"><span class="sdot "></span><div><b>Ask first is on</b><p>Trunks ask before they send, delete, spend money or install anything.</p></div></div>
    <div class="sec"><h2>Without asking, Trunks may…</h2>
      <div class="ctl"><b>Read files in Documents and Downloads</b><input class="sw" type="checkbox" id="p-read" aria-label="Read files in Documents and Downloads" data-sw="set"><small>Reading never changes a file.</small></div>
      <div class="ctl"><b>Use the browser on this computer</b><input class="sw" type="checkbox" id="p-browse" aria-label="Use the browser on this computer" data-sw="set"><small>Signs in with your saved sign-ins. You can take over any time.</small></div>
      <div class="ctl"><b>Send email and messages</b><input class="sw" type="checkbox" id="p-send" aria-label="Send email and messages" data-sw="set"><small>Off means every message waits for your yes.</small></div>
      <div class="ctl"><b>Install tools and packages</b><input class="sw" type="checkbox" id="p-install" aria-label="Install tools and packages" data-sw="set"><small>Off means a request shows up in your Inbox.</small></div>
      <div class="ctl"><b>Record tasks so you can watch them again</b><input class="sw" type="checkbox" id="p-record" aria-label="Record tasks so you can watch them again" data-sw="set"><small>Recordings stay on this computer.</small></div>
    </div>
    <details class="adv"><summary><svg class="i s chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>Advanced</summary>
      <div class="ctl"><b>When tools are loaded</b><span class="right"><span class="seg" role="group" aria-label="When tools are loaded"><button type="button" aria-pressed="false" data-act="seg">Never</button><button type="button" aria-pressed="true" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small>"When needed" keeps a tool one step away until a task calls for it.</small></div>
      <div class="ctl"><b>Stop a Trunk that repeats itself</b><input class="sw" type="checkbox" id="p-loop" aria-label="Stop a Trunk that repeats itself" data-sw="set"><small>After 5 identical steps it pauses and asks you.</small></div>
      <div class="ctl"><b>Trusted folders</b><span class="right"><button class="btn sm" type="button" data-act="toast" data-msg="Add a folder Trunks may change without asking.">Add</button></span><small></small></div>
    </details>
    <div class="danger"><div><b>Lockdown</b><p>One switch that stops every Trunk from sending, changing or spending anything.</p></div><button class="btn bad" type="button" data-act="lock">Turn Lockdown on</button></div>`;

const PINNED = `<div class="sec"><h2>Pinned settings</h2><p class="hint" data-css="margin:0 0 8px">A pinned setting is fixed. Someone else who uses this computer sees it pinned and can't change it any way.</p><div class="rows"><div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3.5 3.5h-11L10 9zM12 12.5V20"></path></svg></span><span class="grow"><b>Full access</b><small>Nobody but you can choose Full access for a conversation.</small></span><button class="btn ghost sm" type="button" data-act="pin-rm8" data-i="0">Unpin</button></div><div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3.5 3.5h-11L10 9zM12 12.5V20"></path></svg></span><span class="grow"><b>Lockdown</b><small>Only you can switch Lockdown off.</small></span><button class="btn ghost sm" type="button" data-act="pin-rm8" data-i="1">Unpin</button></div></div><div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="pin-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Pin a setting</button></div></div>`;

const RULES = `<div class="sec x15-sec"><h2>Rules for each tool and folder</h2><p class="hint" data-css="margin:0 0 6px">The first rule that matches wins. Everything else follows the mode.</p><div class="rows"><div class="prow rule15"><span class="pill ok">Allow</span><span class="grow"><b>git status, git log, git diff</b><small>anywhere - rule 1</small></span><button class="icon-btn" type="button" aria-label="Move up" data-act="toast" data-msg="Moved up."><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"></path></svg></button></div></div><div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="toast" data-msg="New rule: pick a tool, a folder or site, and allow, ask or never."><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add a rule</button></div><div class="ctl"><b>Practice runs</b><input class="sw" type="checkbox" id="f15-practice-runs" aria-label="Practice runs" data-sw="set"><small>A Trunk can show what it would do without doing it.</small></div><div class="ctl"><b>Messages per conversation per hour</b><span class="right num15"><input class="inp" value="60" aria-label="Messages per conversation per hour"></span><small>Stops a runaway loop.</small></div></div><div class="sec x15-sec"><h2>Checks before anything runs</h2><div class="ctl"><b>Scan commands for hidden characters</b><input class="sw" type="checkbox" id="f15-scan-commands-for-hidden-characters" aria-label="Scan commands for hidden characters" data-sw="set"><small>Invisible and look-alike characters that hide what a command does.</small></div><div class="ctl"><b>Scan for personal details</b><input class="sw" type="checkbox" id="f15-scan-for-personal-details" aria-label="Scan for personal details" data-sw="set"><small>Card numbers, ID numbers and addresses are held back from outside services.</small></div><div class="ctl"><b>Authenticator code for sensitive tools</b><input class="sw" type="checkbox" id="f15-authenticator-code-for-sensitive-tools" aria-label="Authenticator code for sensitive tools" data-sw="set"><small>A six-digit code before sending money or deleting a lot.</small></div></div>`;

const ISOLATION = `<div class="sec x15-sec"><h2>Isolation</h2><div class="ctl"><b>A container per Trunk</b><span class="right"><span class="seg" role="group" aria-label="A container per Trunk"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="true" data-act="seg">For code</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small></small></div><div class="ctl"><b>System sandbox for commands</b><span class="right"><span class="seg" role="group" aria-label="System sandbox for commands"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="true" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small></small></div><div class="ctl"><b>Add sign-ins from outside the sandbox</b><input class="sw" type="checkbox" id="f15-add-sign-ins-from-outside-the-sandbox" aria-label="Add sign-ins from outside the sandbox" data-sw="set"><small>The sandbox never holds a password; Branch adds it on the way out.</small></div><div class="ctl"><b>Verify each release</b><input class="sw" type="checkbox" id="f15-verify-each-release" aria-label="Verify each release" data-sw="set"><small>Checks the signature before installing an update.</small></div><div class="ctl"><b>Pin SSH hosts</b><input class="sw" type="checkbox" id="f15-pin-ssh-hosts" aria-label="Pin SSH hosts" data-sw="set"><small>Refuses a computer whose fingerprint changed.</small></div><div class="ctl"><b>Downloads may come from</b><span class="right"><span class="seg" role="group" aria-label="Downloads may come from"><button type="button" aria-pressed="false" data-act="seg">Anywhere</button><button type="button" aria-pressed="true" data-act="seg">Known sites</button><button type="button" aria-pressed="false" data-act="seg">Ask each time</button></span></span><small></small></div></div>`;

export function draw() {
  const lev = level();
  let html = HEAD + BASE_SWITCHES + PINNED;
  if (lev >= 1) html += RULES;
  if (lev >= 2) html += ISOLATION;
  return html;
}

export function init() {
  // Re-mount permissions module after every render
  const root = document.getElementById("perm-mount");
  if (root) {
    root.innerHTML = "";
    mountPermissions(root);
  }
}


markLive([]);
