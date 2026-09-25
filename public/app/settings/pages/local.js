/* Settings › local: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { renderNow } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";

let localData = null;

async function loadLocalData() {
  try {
    const data = await api("local-models");
    localData = data || { ollama: {}, lmStudio: {}, hardware: {}, recommendations: [] };
  } catch (err) {
    console.error("Failed to load local data:", err);
    localData = { ollama: {}, lmStudio: {}, hardware: {}, recommendations: [] };
  }
  renderNow();
}

export function draw() {
  if (!localData) {
    return `<h1>On this computer</h1><p class="lede">Models that run here, free and private. Branch looks at this computer first and only offers what fits.</p><p class="hint">Loading...</p>`;
  }

  const hw = localData.hardware || {};
  const models = localData.models || [];
  const runtimes = localData.runtimes || [];

  let html = `<h1>On this computer</h1><p class="lede">Models that run here, free and private. Branch looks at this computer first and only offers what fits.</p>`;

  // Hardware info
  html += `<div class="hw12">`;
  html += `<div class="hw-c12"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect><path d="M9.5 9.5h5v5h-5zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"></path></svg></span><span><small>Processor</small><b>${esc(hw.processor || 'Unknown')}</b></span></div>`;
  html += `<div class="hw-c12"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"></path><path d="M3 13l9 5 9-5"></path></svg></span><span><small>Memory</small><b>${esc(hw.memory || 'Unknown')}</b></span></div>`;
  html += `<div class="hw-c12"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"></rect><path d="M9 20h6M12 16.5V20"></path></svg></span><span><small>Graphics</small><b>${esc(hw.gpu || 'Unknown')}</b></span></div>`;
  html += `<div class="hw-c12"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"></path></svg></span><span><small>Free space</small><b>${esc(hw.freeSpace || 'Unknown')}</b></span></div>`;
  html += `<div class="hw-c12"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2"></rect><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4"></path></svg></span><span><small>Runtime</small><b>${esc(hw.runtime || 'None')}</b></span></div>`;
  html += `</div>`;

  // Recommended models
  html += `<div class="sec"><h2>Recommended for you</h2><div class="lm-grid12">`;

  if (models.length === 0) {
    html += `<p class="empty">No models available. Install a runtime first.</p>`;
  } else {
    models.forEach((model) => {
      const fitClass = model.fit === 'great' ? 'fit-great' : model.fit === 'ok' ? 'fit-ok' : 'fit-no';
      const statusClass = model.fit === 'great' ? 'ok' : model.fit === 'ok' ? 'warn' : 'no';
      const statusText = model.fit === 'great' ? 'Runs great on your graphics card' :
                        model.fit === 'ok' ? 'Runs, a little slower (uses memory)' :
                        'Too big for this computer';

      html += `<div class="lm12 ${fitClass}"><div class="lm-h12"><b>${esc(model.name)}</b><span class="pill ${statusClass}"><i></i>${statusText}</span></div>`;
      html += `<p>${esc(model.description)}</p>`;
      html += `<div class="lm-tags12">`;
      if (model.tags) {
        model.tags.forEach(tag => {
          html += `<span class="tag6">${esc(tag)}</span>`;
        });
      }
      html += `</div>`;

      if (model.versions) {
        html += `<div class="seg lm-v12">`;
        model.versions.forEach((version) => {
          html += `<button type="button" data-act="lm-v" data-id="${esc(model.id)}" data-v="${esc(version.key)}" aria-pressed="${version.selected ? 'true' : 'false'}">${esc(version.label)}</button>`;
        });
        html += `</div>`;
      }

      html += `<div class="acts">`;
      if (model.running) {
        html += `<span class="pill done"><i></i>Running · port ${esc(String(model.port))}</span><button class="btn sm" type="button" data-act="lm-chat">Say hello</button><button class="btn ghost sm" type="button" data-act="lm-rm" data-id="${esc(model.id)}">Remove</button>`;
      } else if (model.fit !== 'no') {
        html += `<button class="btn pri sm" type="button" data-act="lm-get" data-id="${esc(model.id)}"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>Install ${esc(model.size)}</button>`;
      } else {
        html += `<button class="btn ghost sm" type="button" data-act="lm-get" data-id="${esc(model.id)}" disabled=""><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>Install ${esc(model.size)}</button>`;
      }
      html += `</div></div>`;
    });
  }

  html += `</div></div>`;

  // Runtimes
  html += `<div class="sec"><h2>Runtimes</h2><div class="rows">`;

  const allRuntimes = [
    { name: 'Ollama', abbr: 'OL', bg: '#35606E', desc: 'Runs on this computer, so nothing leaves it and nothing is charged. Install Ollama and run `ollama serve`. No key needed.' },
    { name: 'LM Studio', abbr: 'LS', bg: '#35606E', desc: 'Runs on this computer. Load a model in LM Studio and start its server. Any placeholder key works.' },
    { name: 'vLLM', abbr: 'VL', bg: '#9A6A1A', desc: 'Runs on this computer. Start vLLM with its OpenAI-compatible server. Any placeholder key works.' },
    { name: 'llama.cpp', abbr: 'LC', bg: '#6B4A8A', desc: 'Runs on this computer. Start llama-server from llama.cpp. Any placeholder key works.' },
    { name: 'LocalAI', abbr: 'LO', bg: '#5B6B2E', desc: 'Runs on this computer and can also make speech and pictures. Any placeholder key works.' },
    { name: 'Jan', abbr: 'JA', bg: '#6B4A8A', desc: 'Runs on this computer. Turn on Jan\'s local server. Any placeholder key works.' },
    { name: 'LiteLLM proxy', abbr: 'LI', bg: '#5B6B2E', desc: 'A proxy you run yourself that speaks OpenAI\'s shape and forwards to whichever service you configured behind it. Point this at wherever you run it.' }
  ];

  allRuntimes.forEach((rt) => {
    const found = runtimes.find(r => r.name === rt.name);
    const status = found ? 'ok' : 'not-found';
    const statusText = found ? 'Found' : 'Not found';

    html += `<div class="prow"><span class="logo" data-css="width:30px;height:30px;background:${rt.bg}"><b data-css="font:700 11px var(--sans);color:#fff">${rt.abbr}</b></span>`;
    html += `<span class="grow"><b>${esc(rt.name)}</b><small>${esc(rt.desc)}</small></span>`;

    if (found) {
      html += `<span class="pill ${status}"><i></i>${statusText}</span>`;
    } else {
      html += `<button class="btn ghost sm" type="button" data-act="toast" data-msg="Looking for ${esc(rt.name)} on this computer… not found. Branch can use it as soon as it runs.">Look for it</button>`;
    }

    html += `</div>`;
  });

  html += `</div></div>`;

  return html;
}

export function init() {
  loadLocalData();
  on("lm-get", (el) => {
    const modelId = el.dataset.id;
    if (modelId) {
      api("local-models/pull", { model: modelId })
        .then(() => { toast("Starting download..."); loadLocalData(); }, (e) => toast(e.message));
    }
  });
  on("lm-rm", (el) => {
    const modelId = el.dataset.id;
    if (modelId) {
      api("local-models/remove", { model: modelId })
        .then(() => { toast("Model removed."); loadLocalData(); }, (e) => toast(e.message));
    }
  });
  markLive(["lm-get", "lm-rm"]);
}

export async function load() {
  await loadLocalData();
}

export const live = {
  "lm-get": true,
  "lm-rm": true
};

export function after(col) {
  // Set up control listeners after rendering
}
