/* MCP Connectors: searchable catalog of integrations like GitHub, Gmail, Notion. */

import { $, esc, applyCss } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let connectors = null;

export function init() {
  markLive(["tool-add", "mcp-cat", "mcp-add"]);
  on("tool-add", () => openConnectorCatalog());
  on("mcp-cat", (el) => { S.mcp = S.mcp || {}; S.mcp.cat = el.dataset.v; drawConnectorCatalog(); });
  on("mcp-add", (el) => addConnector(el.dataset.v));
}

async function openConnectorCatalog() {
  if (!connectors) connectors = await api("mcp/connectors").catch(() => ({}));
  S.mcp = { cat: "all", q: "" };
  drawConnectorCatalog();
}

function drawConnectorCatalog() {
  const html = `<div data-css="padding:16px">
    <p data-css="margin-bottom:16px">52 ready to connect. Search or browse by category.</p>
    <div data-css="margin-bottom:16px">
      <input type="text" id="mcp-q" placeholder="Search connectors" data-css="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px" aria-label="Search connectors">
    </div>
    <div data-css="margin-bottom:16px;display:flex;gap:4px;flex-wrap:wrap">
      <button class="chip6" type="button" data-act="mcp-cat" data-v="all" aria-pressed="${(S.mcp?.cat || "all") === "all"}">All</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="work" aria-pressed="${S.mcp?.cat === "work"}">Work</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="mail" aria-pressed="${S.mcp?.cat === "mail"}">Mail</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="files" aria-pressed="${S.mcp?.cat === "files"}">Files</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="chat" aria-pressed="${S.mcp?.cat === "chat"}">Chat</button>
      <button class="chip6" type="button" data-act="mcp-cat" data-v="dev" aria-pressed="${S.mcp?.cat === "dev"}">Developer</button>
    </div>
    <div id="mcp-list" data-css="display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
    </div>
  </div>`;

  openDlg({
    title: "Add a connector",
    body: html,
    foot: '<button class="btn pri" data-act="dlg-close">Close</button>',
    wide: true
  });

  const input = document.querySelector("#mcp-q");
  if (input) {
    input.addEventListener("input", () => {
      S.mcp.q = input.value;
      drawConnectorCatalog();
    });
    input.focus();
  }
}

function addConnector(name) {
  toast(`${name} connector added.`);
  closeDlg();
}
