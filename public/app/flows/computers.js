/* Adding a computer or phone (the computers popover's "Add a computer or phone…", and Settings › Computer's "Add a
   computer"). Both open the prototype's dialogs; what is inside them stays greyed or empty: the engine finds no
   computers on the network, a pairing code and letting a device in are pairing (kept for separate review), an SSH
   computer gives Trunks another machine to act on, and a private computer on this PC or a KeepOak cloud computer are
   not in the engine. The phone tab hands over to the phone pairing dialog. */

import { openDlg, closePop, ic } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const TABS = [["network", "On your network"], ["code", "With a code"], ["phone", "Your phone"]];
/* The prototype's note under the tabs (addComputer): what pairing leads to. Pairing itself stays greyed. */
const AFTER = '<div class="status" data-css="margin-top:4px"><span class="sdot"></span><div><b>What happens after pairing</b><p>The other computer’s Trunks show in the switcher. You can send it tasks, and it asks you before doing anything. Unpair any time from Settings › Computer.</p></div></div>';

function addComputer(tab) {
  closePop();
  const body = tab === "phone" ? '<p data-css="margin:0">Scan with the Branch app on your phone.</p><button class="btn" type="button" data-act="pair">Show the phone code</button>' : "";
  openDlg({ title: "Add a computer or phone",
    body: `<div class="tabs" data-css="margin:0">${TABS.map(([k, l]) => `<button class="tab" type="button" aria-selected="${tab === k}" data-act="ac-tab" data-v="${k}">${l}</button>`).join("")}</div>${body}${AFTER}` });
}

const KINDS = [["sandbox", "shield", "A new private computer on this PC", "A sealed Windows box."], ["pair", "monitor", "Another computer with Branch", "A PC, a Mac or a Linux box. Pair it once with a six-digit code."], ["cloud", "globe", "A KeepOak cloud computer", "Always on, works while this PC sleeps. Billed by KeepOak."], ["remote", "key", "A computer over remote desktop or SSH", "Proposal: for a machine that can’t run Branch itself."]];

function addKind() {
  closePop();
  openDlg({ title: "Add a computer",
    body: `<div class="provs">${KINDS.map(([v, i, n, s]) => `<button class="prov" type="button" data-act="comp-add-go" data-v="${v}"><span class="ico-tile">${ic(i, "s")}</span><b>${n}</b><small>${s}</small></button>`).join("")}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>' });
}

export function init() {
  markLive(["addcomp", "ac-tab", "comp-add"]);
  on("addcomp", () => addComputer("network"));
  on("ac-tab", (el) => addComputer(el.dataset.v));
  on("comp-add", () => addKind());
}
