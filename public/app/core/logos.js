/* Service marks. A service's own official mark is shown only where the owner of the mark lets another app show it to
   say the app connects to that service, and then as published: unmodified, in its own colour, on a plain light tile
   with room around it (public/art/providers/, public/art/channels/; sources and licences in THIRD_PARTY_NOTICES.md).
   Every other service gets its initials on a steady colour: most makers (OpenAI, Anthropic, Google, Meta, Discord,
   Signal, Matrix, Mastodon) ask for written permission before their mark is used, and a look-alike drawing is worse
   than none. Email is not a brand, so it gets the window's own mail glyph. */

import { esc } from "./dom.js";
import { ICONS } from "./icons.js";

/* id -> [file, the mark's own colour]. GitHub: brand.github.com/foundations/logo ("inform others that your project
   integrates with GitHub"; black or white, unmodified). Telegram: telegram.org/tour/screenshots ("feel free to use
   these Telegram logos ... make sure people understand you're not representing Telegram officially"). */
const OFFICIAL = {
  github: "art/providers/github.svg",
  telegram: "art/channels/telegram.svg",
};
const ALIAS = { "github-models": "github", "github-copilot": "github", copilot: "github", "cli-copilot": "github" };
/* The steady colour of a service's initials: its own colour where it has one, never its mark. */
const TINTS = { openai: "#0F0F0F", chatgpt: "#0F0F0F", codex: "#0F0F0F", anthropic: "#D97757", claude: "#D97757", gemini: "#1E1F24",
  google: "#1E1F24", drive: "#1FA463", discord: "#5865F2", slack: "#4A154B", whatsapp: "#25D366", email: "#2E6A8A",
  messenger: "#6B4A8A", instagram: "#8A4F2A", matrix: "#3A5A99", signal: "#2F7A4A", outlook: "#0F6CBD", ollama: "#615CED" };
const PALETTE = ["#2E6A8A", "#6B4A8A", "#8A4F2A", "#3A5A99", "#2F7A4A", "#8A2F4F", "#4F6B2A", "#2A6B6B"];
/* A pool or connection id names its service first ("cli-claude-code", "openai-work"). */
const PREFIX = { "cli-claude-code": "claude", "cli-codex": "codex", "cli-gemini-cli": "gemini" };

function tint(key) {
  const known = Object.keys(TINTS).find((k) => key === k || key.startsWith(`${k}-`)) ?? Object.keys(PREFIX).find((k) => key === k);
  if (known) return TINTS[PREFIX[known] ?? known];
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* id: the engine's service, pool or channel id (its first two letters stand in for a missing mark); size in px. */
export function logo(id, name = id, size = 30) {
  const key = String(id ?? "").toLowerCase();
  const box = `width:${size}px;height:${size}px;background:`;
  const file = OFFICIAL[ALIAS[key] ?? key];
  const inner = Math.round(size * 0.62);
  if (file) return `<span class="logo mark14" data-css="${box}#fff"><img src="/${file}" alt="" width="${inner}" height="${inner}"></span>`;
  if (key === "email") return `<span class="logo" data-css="${box}${tint(key)}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true" data-css="color:#fff;width:${inner}px;height:${inner}px">${ICONS.mail ?? ""}</svg></span>`;
  const text = (key || String(name)).replace(/^cli-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return `<span class="logo" data-css="${box}${tint(key)}"><b data-css="font:700 11px var(--sans);color:#fff">${esc(text)}</b></span>`;
}
