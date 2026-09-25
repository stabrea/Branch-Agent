import { esc } from "../../core/dom.js";
import { ic } from "../../core/ui.js";
import { statusBox } from "../parts.js";

export function draw() {
  return `<h1>Accounts</h1>
    <p class="lede">Your model accounts, the order Branch uses them in, and your keepoak.com account.</p>
    ${statusBox("Accounts signed in", "Branch never sees your passwords. Each account is billed by its own site.")}
    <div class="sec"><h2>Signed in</h2>
      <div class="rows">
        <div class="prow">
          <span class="ico-tile">${ic("key", "s")}</span>
          <span class="grow">
            <b>Claude</b>
            <small>Anthropic · used by every Trunk</small>
          </span>
          <button class="btn sm" type="button" data-act="toast" data-msg="Signed in. They manage access on their site.">Manage</button>
        </div>
      </div>
    </div>
    <div class="acts" data-css="margin-top:14px"><button class="btn pri" type="button" data-act="toast" data-msg="Sign in on the provider's site.">Add an account</button></div>`;
}

export function init() {}
