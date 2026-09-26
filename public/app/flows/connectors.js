/* Adding a tool, from Customize › Tools (design doc 5.7, the prototype's toolAdd): a connector, a skill or another agent.
   The engine keeps no connector catalog, so the catalog dialog lists none and offers your own server. Its Test and
   Add server stay greyed: trying a server starts the typed program (POST /api/mcp/try), and nothing saves one yet.
   A skill from a file is real: the SKILL.md is read here and sent to POST /api/skills/install. The skill library,
   GitHub and writing one with Branch stay greyed, as do all three ways of connecting another agent (a card address
   this engine can reach, pairing, and a KeepOak computer). */

import { $, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic } from "../core/ui.js";
import { refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { showTool } from "../places/customize.js";
import { t } from "../../i18n.js";

const prov = (act, v, icon, name, sub) => `<button class="prov" type="button" data-act="${act}" data-v="${v}">${icon}<b>${name}</b><small>${sub}</small></button>`;
const tile = (name) => `<span class="ico-tile">${ic(name, "s")}</span>`;

function connectorCatalog() {
  openDlg({ title: t("window.flows.conn.add-connector"), wide: true,
    body: `<div class="aa-list12"><p class="empty">${t("window.flows.conn.nothing")}</p></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn" type="button" data-act="t9-own">${t("window.flows.conn.own")}</button>` });
}

function ownServer() {
  const how = [t("window.flows.conn.command"), t("window.flows.conn.web")].map((o) => `<button type="button" data-act="seg" aria-pressed="false">${o}</button>`).join("");
  openDlg({ title: t("window.flows.conn.own-mcp"),
    body: `<div class="fld"><span>${t("window.flows.conn.how")}</span><span class="seg">${how}</span></div><label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="mcp-name"></label><label class="fld"><span>${t("window.flows.conn.cmd")}</span><input class="inp code6" id="mcp-cmd" data-css="height:34px"></label><label class="fld"><span>${t("window.flows.conn.secrets")}</span><input class="inp" id="mcp-secrets"></label><div id="mcp-test"></div>`,
    foot: `<button class="btn" type="button" data-act="mcp-test">${t("window.flows.conn.test")}</button><button class="btn pri" type="button" data-act="mcp-save">${t("window.flows.conn.add-server")}</button>` });
}

function addSkill() {
  openDlg({ title: t("window.flows.conn.add-skill"),
    body: `<div class="provs">${prov("sk-lib", "lib", tile("book"), t("window.flows.conn.library"), t("window.flows.conn.library-hint"))}${prov("sk-src", "file", tile("doc"), t("window.flows.conn.file"), t("window.flows.conn.file-hint"))}${prov("sk-git", "git", logo("github", "GitHub", 32), t("window.flows.conn.github"), t("window.flows.conn.github-hint"))}${prov("sk-write", "write", tile("spark"), t("window.flows.conn.write"), t("window.flows.conn.write-hint"))}</div><input type="file" id="sk-file" accept=".md,text/markdown,text/plain" hidden>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

function connectAgent() {
  openDlg({ title: t("window.chat.beside.connect-agent"),
    body: `<div class="provs">${prov("ag-add", "card", tile("globe"), t("window.flows.conn.a2a"), t("window.flows.conn.a2a-hint"))}${prov("ag-pair", "pair", tile("monitor"), t("window.flows.conn.other-branch"), t("window.flows.conn.other-branch-hint"))}${prov("ag-ko", "ko", tile("layers"), t("window.flows.conn.keepoak"), t("window.flows.conn.keepoak-hint"))}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

/* The SKILL.md is sent as it is; the engine checks it, scans it and answers with the installed skill or its reason. */
async function installFile(file) {
  if (!file) return;
  try {
    const skill = await api("skills/install", { document: await file.text() });
    closeDlg();
    await refresh();
    showTool("skills", skill.id);
    renderNow();
    toast(t("window.flows.conn.skill-added"));
  } catch (error) { toast(error.message); }
}

const ADD = { mcp: connectorCatalog, skills: addSkill, agents: connectAgent };

export function init() {
  markLive(["tool-add", "t9-own", "sk-src", "sw:sk-file"]);
  /* A plugin or a command-line tool has no add form the engine backs yet: the button opens that kind in Customize. */
  on("tool-add", (el) => { if (ADD[el.dataset.v]) ADD[el.dataset.v](); else { closePop(); showTool(el.dataset.v, null); renderNow(); } });
  on("t9-own", () => ownServer());
  on("sk-src", () => $("#sk-file")?.click());
  document.addEventListener("change", (e) => { if (e.target.id === "sk-file") installFile(e.target.files?.[0]); });
}
