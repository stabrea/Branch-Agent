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
import { t } from "../../i18n.js";
import { init as initComputers17 } from "./computers17.js"; // pass 17 part D §9

const TABS = [["network", "window.flows.comp.network"], ["code", "window.flows.comp.code"], ["phone", "studio.tab.phone"]];
/* The prototype's note under the tabs (addComputer): what pairing leads to. */
const AFTER = () => `<div class="status" data-css="margin-top:4px"><span class="sdot"></span><div><b>${t("window.flows.comp.after")}</b><p>${t("window.flows.comp.after-hint")}</p></div></div>`;

function addDialog(tab, body, foot = "") {
  const tabs = `<div class="tabs" data-css="margin:0">${TABS.map(([k, l]) => `<button class="tab" type="button" aria-selected="${tab === k}" data-act="ac-tab" data-v="${k}">${t(l)}</button>`).join("")}</div>`;
  return openDlg({ title: t("window.flows.comp.add-or-phone"), body: `${tabs}${body}${AFTER()}`, foot });
}

function addComputer(tab) {
  closePop();
  if (tab === "code") return startPairing("code", ({ body, foot }) => addDialog("code", body, foot));
  stopPairing();
  const body = tab === "phone" ? `<p data-css="margin:0">${t("window.flows.comp.scan")}</p><button class="btn" type="button" data-act="pair">${t("window.flows.comp.show-code")}</button>` : "";
  addDialog(tab, body);
}

const KINDS = [["sandbox", "shield", "window.flows.comp.sandbox", "window.flows.comp.sandbox-hint"], ["pair", "monitor", "window.flows.comp.pair", "window.flows.comp.pair-hint"], ["cloud", "cloud17d", "window.flows.comp.cloud", "window.flows.comp.cloud-hint"], ["remote", "key", "window.flows.comp.remote", "window.flows.comp.remote-hint"]];
/* Only pairing is real here; the other kinds are drawn greyed, one by one. */
const OFF = () => ` disabled aria-disabled="true" data-tip="${t("window.flows.coming-soon")}"`;

function addKind() {
  closePop();
  openDlg({ title: t("window.flows.comp.add"),
    body: `<div class="provs">${KINDS.map(([v, i, n, s]) => `<button class="prov${v === "pair" ? "" : " soon"}" type="button" data-act="comp-add-go" data-v="${v}"${v === "pair" ? "" : OFF()}><span class="ico-tile">${ic(i, "s")}</span><b>${t(n)}</b><small>${t(s)}</small></button>`).join("")}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

export function init() {
  markLive(["addcomp", "ac-tab", "comp-add", "comp-add-go"]);
  initComputers17();
  on("addcomp", () => addComputer("network"));
  on("ac-tab", (el) => addComputer(el.dataset.v));
  on("comp-add", () => addKind());
  on("comp-add-go", (el) => { if (el.dataset.v === "pair") startPairing("computer"); });
}
