/* Trunk editor: name, role, look, permissions */

import { esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { openDlg, closeDlg, toast, ic, av } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";

const SHAPES = ["circle", "squircle", "leaf", "acorn", "shield", "hexagon"];
const COLOURS = ["#FF6B6B", "#FFA94D", "#FFD93D", "#6BCB77", "#4D96FF", "#9B59B6"];
const MOTIONS = ["none", "breathe", "sway", "shimmer", "pulse"];

let editingTrunk = null;

function lookTab(trunk) {
  const t = trunk || {};
  const look = t.look || {};
  const color = t.chosenColour || look.colour || COLOURS[0];
  const shape = look.shape ? SHAPES.indexOf(look.shape) : 0;
  const motion = look.motion || "none";
  const emoji = look.emoji || "";
  const face = look.face || "pattern";

  return `
    <div style="display:grid;gap:14px">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:center">
        <div style="width:84px;height:84px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center">
          ${face === "emoji" ? `<span style="font-size:48px">${emoji}</span>` : `<span style="font-size:40px;color:#fff">●</span>`}
        </div>
        <div><button class="btn sm" type="button" data-act="st-shuffle">Shuffle</button></div>
      </div>
      <div><label for="st-name">Name</label><input class="inp" id="st-name" value="${esc(t.name || '')}" placeholder="Scout"></div>
      <div><label for="st-role">What it's for</label><input class="inp" id="st-role" value="${esc(t.role || '')}" placeholder="Research and information"></div>
      <div>
        <label>Colour</label>
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px">
          ${COLOURS.map(c => `<button class="swatch" type="button" style="width:100%;aspect-ratio:1;background:${c};border:2px solid ${c === color ? '#000' : 'transparent'};border-radius:8px;cursor:pointer" aria-label="Colour ${c}" data-act="st-colour" data-v="${c}"></button>`).join('')}
        </div>
      </div>
      <div>
        <label>Shape</label>
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px">
          ${SHAPES.map((sh, i) => `<button class="shape" type="button" style="width:100%;aspect-ratio:1;background:${color};border-radius:${sh === 'circle' ? '50%' : sh === 'squircle' ? '20%' : sh === 'leaf' ? '0 70% 70% 30% / 30% 30% 70% 70%' : sh === 'acorn' ? '0 50% 100% 50% / 50% 0 0 50%' : sh === 'shield' ? '50% 0 50% 100% / 0 100% 100% 0' : '25%'};border:2px solid ${i === shape ? '#000' : 'transparent'};cursor:pointer" aria-label="Shape ${i + 1}" data-act="st-shape" data-v="${i}"></button>`).join('')}
        </div>
      </div>
      <div>
        <label>How it moves</label>
        <div style="display:grid;grid-template-columns:repeat(${MOTIONS.length},1fr);gap:8px">
          ${MOTIONS.map(m => `<button type="button" style="padding:8px;border:1px solid #ccc;border-radius:6px;background:${m === motion ? '#e0e0e0' : 'white'};cursor:pointer" aria-pressed="${m === motion}" data-act="st-anim" data-v="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div>
        <label for="st-emoji">Emoji instead of a face</label>
        <input class="inp" id="st-emoji" type="text" maxlength="2" value="${esc(emoji)}" placeholder="😊" data-act="emo15">
      </div>
    </div>
  `;
}

function mayTab(trunk) {
  const t = trunk || {};
  return `
    <div style="display:grid;gap:12px">
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px">
        <label><input type="checkbox" ${(t.permissions?.read !== false) ? 'checked' : ''} data-act="perm-read"> Read files in Documents and Downloads</label>
        <small style="display:block;margin-top:4px;color:#666">Reading never changes a file.</small>
      </div>
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px">
        <label><input type="checkbox" ${(t.permissions?.browse !== false) ? 'checked' : ''} data-act="perm-browse"> Use the browser</label>
        <small style="display:block;margin-top:4px;color:#666">With your saved sign-ins.</small>
      </div>
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px">
        <label>Send email and messages</label>
        <select class="inp" data-act="perm-send" style="width:100%;margin-top:4px">
          <option value="ask" ${(t.permissions?.send ?? 'ask') === 'ask' ? 'selected' : ''}>Ask first</option>
          <option value="allow" ${(t.permissions?.send ?? 'ask') === 'allow' ? 'selected' : ''}>Allowed</option>
        </select>
      </div>
      <div style="padding:12px;border:1px solid #ccc;border-radius:8px">
        <label>Spend money</label>
        <select class="inp" style="width:100%;margin-top:4px;opacity:0.5">
          <option>Never</option>
        </select>
        <small style="display:block;margin-top:4px;color:#666">Never, whatever mode Branch is in.</small>
      </div>
    </div>
  `;
}

export function openTrunkEditor(id) {
  editingTrunk = id;
  const trunk = id ? E.trunks?.find(t => t.id === id) : { name: "", role: "", look: {}, permissions: {} };

  const tabs = [
    ["look", "Look"],
    ["may", "What it may do"]
  ];

  const tab = "look";
  const html = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:16px;min-height:0">
      <div></div>
      <div style="display:grid;gap:14px;min-width:0">
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;border-bottom:1px solid #ccc">
          ${tabs.map(([k, l]) => `<button class="tab" role="tab" type="button" aria-selected="${k === tab}" data-act="st-tab" data-v="${k}" style="padding:12px;border:none;background:none;cursor:pointer;font-weight:${k === tab ? 'bold' : 'normal'};border-bottom:${k === tab ? '2px solid #000' : 'none'}">${l}</button>`).join('')}
        </div>
        ${lookTab(trunk)}
      </div>
    </div>
  `;

  openDlg({
    title: id ? `Edit ${trunk.name}` : "New Trunk",
    body: html,
    wide: true,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="st-save">Save</button>`
  });
}

export function init() {
  on("new-trunk", () => openTrunkEditor());
  on("edit", (el) => openTrunkEditor(el.dataset.id));
  on("st-tab", (el) => {
    const tab = el.dataset.v;
    const editDiv = el.closest(".dlg-body");
    if (!editDiv) return;
    // TODO: Switch tab content
  });
  on("st-save", async (el) => {
    const nameInput = document.querySelector("#st-name");
    const roleInput = document.querySelector("#st-role");
    const emojiInput = document.querySelector("#st-emoji");
    const name = nameInput?.value || "Unnamed";
    const role = roleInput?.value || "";
    const emoji = emojiInput?.value || "";

    if (editingTrunk) {
      await api(`trunks/${editingTrunk}`, {
        name,
        role,
        look: { emoji }
      }, "PUT");
    } else {
      await api("trunks", { name, role, look: { emoji } }, "POST");
    }

    closeDlg();
    renderNow();
    toast(`${name} is saved.`);
  });
  on("st-colour", (el) => {
    const color = el.dataset.v;
    // Update preview color
  });
  on("st-shape", (el) => {
    const shape = SHAPES[parseInt(el.dataset.v)] || SHAPES[0];
    // Update preview shape
  });
  on("st-anim", (el) => {
    const anim = el.dataset.v;
    // Save animation
  });
  on("st-shuffle", () => {
    // Randomize face/color/shape - window-only state
    const colors = COLOURS;
    const shapes = SHAPES;
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomShape = shapes[Math.floor(Math.random() * shapes.length)];
    if (editingTrunk && E.trunks) {
      const trunk = E.trunks.find(t => t.id === editingTrunk);
      if (trunk) {
        trunk.chosenColour = randomColor;
        if (trunk.look) trunk.look.shape = randomShape;
      }
    }
    renderNow();
  });
  on("emo15", (el) => {
    // Update emoji in real-time preview
    const emoji = el.value || "";
    if (editingTrunk && E.trunks) {
      const trunk = E.trunks.find(t => t.id === editingTrunk);
      if (trunk && trunk.look) {
        trunk.look.emoji = emoji;
      }
    }
  });
}
