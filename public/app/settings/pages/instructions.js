/* Settings › instructions: bind real engine data and wire controls. */
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { render } from "../../core/dom.js";

let files = null;
let selectedOwner = "branch";

async function loadFiles() {
  try {
    const data = await api("settings-kit/files");
    files = data;
  } catch (err) {
    console.error("Failed to load instruction files:", err);
    files = { files: [] };
  }
}

function draw() {
  let html = `<h1>Instructions &amp; personality</h1><p class="lede">Plain files every Trunk reads before it works. They work the same as in other agents, so a file written for one of them works here.</p>
  <div class="fld" data-css="margin-top:6px"><span>Whose files</span><span class="acts" data-css="gap:6px"><button class="chip6" type="button" data-act="if-owner" data-v="branch" aria-pressed="true">Every Trunk</button><button class="chip6" type="button" data-act="if-owner" data-v="scout" aria-pressed="false">Scout</button><button class="chip6" type="button" data-act="if-owner" data-v="ledger" aria-pressed="false">Ledger</button><button class="chip6" type="button" data-act="if-owner" data-v="ada" aria-pressed="false">Ada</button><button class="chip6" type="button" data-act="if-owner" data-v="field" aria-pressed="false">Fieldnotes</button></span></div>
  <div class="rows" data-css="margin-top:8px">`;

  if (files && files.files) {
    for (const f of files.files) {
      const sizeText = f.bytes ? `${Math.round(f.bytes / 100) / 10} KB` : "Empty";
      const statusText = f.hasContent ? "Edit" : "Write";
      html += `<div class="prow"><code class="if-name">${f.name}</code><span class="grow"><b data-css="font-weight:500">${f.description}</b><small>${sizeText}</small></span><button class="btn sm" type="button" data-act="if-open" data-f="${f.name}">${statusText}</button></div>`;
    }
  }

  html += `</div>
  <p class="hint">A file can't widen what Branch may do; Permissions still decides. A Trunk's own copy replaces the shared one for that Trunk only.</p>`;

  return html;
}

export async function load() {
  await loadFiles();
}

export function init() {
  // Handlers for instruction file controls
}

export const live = {
  "if-owner": true,
  "if-open": true,
};
