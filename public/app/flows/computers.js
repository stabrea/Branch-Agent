/* Adding a computer or phone (the computers popover's "Add a computer or phone…", and Settings › Computer's "Add a
   computer"), 1:1 with the prototype's two dialogs. Pairing is the engine's Devices (flows/pair.js): the "With a code"
   tab and "Another computer with Branch" make a real invitation, and the device that answers waits for the owner's
   "Let it in"; the phone tab hands over to the phone pairing dialog. What stays greyed: the network tab (the engine
   finds no computers on the network), a private computer on this PC and a cloud computer (not in the engine) and a
   computer over remote desktop or SSH (gives Trunks another machine to act on; not part of pairing). */

import { openDlg, closePop, ic } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { startPairing, stopPairing } from "./pair.js";

const TABS = [["network", "On your network"], ["code", "With a code"], ["phone", "Your phone"]];
/* The prototype's note under the tabs (addComputer): what pairing leads to. */
const AFTER = '<div class="status" data-css="margin-top:4px"><span class="sdot"></span><div><b>What happens after pairing</b><p>The other computer’s Trunks show in the switcher. You can send it tasks, and it asks you before doing anything. Unpair any time from Settings › Computer.</p></div></div>';

function addDialog(tab, body, foot = "") {
  const tabs = `<div class="tabs" data-css="margin:0">${TABS.map(([k, l]) => `<button class="tab" type="button" aria-selected="${tab === k}" data-act="ac-tab" data-v="${k}">${l}</button>`).join("")}</div>`;
  return openDlg({ title: "Add a computer or phone", body: `${tabs}${body}${AFTER}`, foot });
}

function addComputer(tab) {
  closePop();
  if (tab === "code") return startPairing("code", ({ body, foot }) => addDialog("code", body, foot));
  stopPairing();
  const body = tab === "phone" ? '<p data-css="margin:0">Scan with the Branch app on your phone.</p><button class="btn" type="button" data-act="pair">Show the phone code</button>' : "";
  addDialog(tab, body);
}

const KINDS = [["sandbox", "shield", "A new private computer on this PC", "A sealed Windows box."], ["pair", "monitor", "Another computer with Branch", "A PC, a Mac or a Linux box. Pair it once with a six-digit code."], ["cloud", "globe", "A KeepOak cloud computer", "Always on, works while this PC sleeps. Billed by KeepOak."], ["remote", "key", "A computer over remote desktop or SSH", "Proposal: for a machine that can’t run Branch itself."]];
/* Only pairing is real here; the other kinds are drawn greyed, one by one. */
const OFF = ' disabled aria-disabled="true" data-tip="Coming soon"';

function addKind() {
  closePop();
  openDlg({ title: "Add a computer",
    body: `<div class="provs">${KINDS.map(([v, i, n, s]) => `<button class="prov${v === "pair" ? "" : " soon"}" type="button" data-act="comp-add-go" data-v="${v}"${v === "pair" ? "" : OFF}><span class="ico-tile">${ic(i, "s")}</span><b>${n}</b><small>${s}</small></button>`).join("")}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>' });
}

export function init() {
  markLive(["addcomp", "ac-tab", "comp-add", "comp-add-go"]);
  on("addcomp", () => addComputer("network"));
  on("ac-tab", (el) => addComputer(el.dataset.v));
  on("comp-add", () => addKind());
  on("comp-add-go", (el) => { if (el.dataset.v === "pair") startPairing("computer"); });
}
