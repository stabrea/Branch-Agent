/* Brand marks from the prototype (design/redesign/dom): a coloured tile with the service's mark, or its initials on a
   steady colour for services without one. */

import { esc } from "./dom.js";

const MARKS = {
  openai: ["#0F0F0F", "<path d=\"M12 3.2l7.6 4.4v8.8L12 20.8 4.4 16.4V7.6z\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.7\"></path><path d=\"M12 7.6l3.8 2.2v4.4L12 16.4l-3.8-2.2V9.8z\" fill=\"#fff\"></path>"],
  anthropic: ["#D97757", "<path d=\"M12 4v16M4 12h16M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6\" stroke=\"#fff\" stroke-width=\"2.2\" stroke-linecap=\"round\"></path>"],
  gemini: ["#1E1F24", "<path d=\"M12 3c.8 4.6 4.4 8.2 9 9-4.6.8-8.2 4.4-9 9-.8-4.6-4.4-8.2-9-9 4.6-.8 8.2-4.4 9-9z\" fill=\"#8AB4F8\"></path>"],
  github: ["#181717", "<path d=\"M12 4a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 12 4z\" fill=\"#fff\"></path>"],
  drive: ["#1FA463", "<path d=\"M9 4.5h6l6 10.2-3 4.8H6l-3-4.8z\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.7\" stroke-linejoin=\"round\"></path>"],
  telegram: ["#2AABEE", "<path d=\"M4.8 11.6l13.4-5.2-2.3 11.2-4.4-3.3-2.3 2.3.3-3.5 5.6-5.1-7 4.3z\" fill=\"#fff\"></path>"],
  discord: ["#5865F2", "<path d=\"M7.2 8.4c3-1.3 6.6-1.3 9.6 0l1.4 7.1c-1.6 1.2-3.2 1.8-4.5 2l-.8-1.4m-1.8 0l-.8 1.4c-1.3-.2-2.9-.8-4.5-2z\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.5\" stroke-linejoin=\"round\"></path><circle cx=\"9.8\" cy=\"12.6\" r=\"1.1\" fill=\"#fff\"></circle><circle cx=\"14.2\" cy=\"12.6\" r=\"1.1\" fill=\"#fff\"></circle>"],
  slack: ["#4A154B", "<path d=\"M9 5v14M15 5v14M5 9h14M5 15h14\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\"></path>"],
  whatsapp: ["#25D366", "<path d=\"M12 4.6a7.4 7.4 0 0 0-6.3 11.3l-1 3.5 3.6-1a7.4 7.4 0 1 0 3.7-13.8z\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.7\"></path>"],
};
const TINTS = { email: "#2E6A8A", messenger: "#6B4A8A", instagram: "#8A4F2A", matrix: "#3A5A99", signal: "#2F7A4A", outlook: "#0F6CBD", ollama: "#615CED" };
const PALETTE = ["#2E6A8A", "#6B4A8A", "#8A4F2A", "#3A5A99", "#2F7A4A", "#8A2F4F", "#4F6B2A", "#2A6B6B"];
const ALIAS = { chatgpt: "openai", codex: "openai", claude: "anthropic", google: "gemini" };

function tint(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[id] ?? PALETTE[h % PALETTE.length];
}

/* id: the engine's service or pool id (its first two letters stand in for a missing mark); size in px. */
export function logo(id, name = id, size = 30) {
  const key = String(id ?? "").toLowerCase();
  const mark = MARKS[ALIAS[key] ?? key] ?? MARKS[Object.keys(MARKS).find((k) => key.includes(k)) ?? ""];
  const box = `width:${size}px;height:${size}px;background:`;
  if (mark) return `<span class="logo" data-css="${box}${mark[0]}"><svg viewBox="0 0 24 24" width="${Math.round(size * 0.66)}" height="${Math.round(size * 0.66)}" aria-hidden="true">${mark[1]}</svg></span>`;
  const text = (key || String(name)).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return `<span class="logo" data-css="${box}${tint(key)}"><b data-css="font:700 11px var(--sans);color:#fff">${esc(text)}</b></span>`;
}
