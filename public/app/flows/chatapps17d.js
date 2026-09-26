/* Pass 17 part D §8 on a chat app's own page (the setup's Manage view), 1:1 with the prototype's patch17d.js: its status
   from the engine's health (GET /api/channels), and, while Telegram refuses its bot token, "Paste a new token", which
   opens the setup at Paste (revfix17d, handled in flows/chat.js) with the note saying what happened. Seeing edited
   messages, albums, online status in the app and per-app formatting are not in the engine yet, so they stay greyed. */

import { esc } from "../core/dom.js";

/** Each app's own formatting, by the prototype's names. */
export const NATIVE = { telegram: "MarkdownV2", slack: "Slack mrkdwn", discord: "Markdown", whatsapp: "WhatsApp styles", matrix: "HTML", signal: "Signal styles" };
export const pill17d = (cls, text) => `<span class="pill ${cls}"><i></i>${esc(text)}</span>`;
/** The engine's health as the prototype draws it: [pill class, word, line]. */
export const stateOf = (health) => (health?.state === "needs attention" ? ["no", "Offline", health.reason ?? ""] : ["ok", "Online", ""]);

export function manage17d(c, health) {
  const [cls, word, line] = stateOf(health);
  const row = (label, title, sub) => `<label class="chx-r17d"><input type="checkbox" class="sw" data-sw="chx17d" aria-label="${esc(label)}"><span><b>${title}</b><small>${esc(sub)}</small></span></label>`;
  return `<div class="chx17d"><div class="chx-h17d">${pill17d(cls, word)}<small>${esc(line)}</small></div>
    ${row("Sees edited messages", "Sees edited messages", "It answers the latest version.")}${row("Photo albums as one message", "Photo albums as one message", "Not one reply per photo.")}${row("Online status in the app", `Online status in ${esc(c.name)}`, "“Online” or “Offline, back soon” in the bot’s description.")}
    <div class="chx-f17d"><b>Formatting</b><span class="seg">${[NATIVE[c.id] ?? "Its own styles", "Plain text"].map((o) => `<button type="button" data-act="chfmt17d" data-id="${esc(c.id)}" data-v="${esc(o)}" aria-pressed="false">${esc(o)}</button>`).join("")}</span></div>
    ${cls === "no" ? '<div class="acts"><button class="btn pri sm" type="button" data-act="revfix17d">Paste a new token</button></div>' : ""}</div>`;
}

/** The note at Paste while a refused token is being replaced. */
export const fixNote17d = () => `<div class="status chfix17d"><span class="sdot bad"></span><div><b>The old token stopped working</b><p>Someone made a new token in BotFather, which revokes the old one. Send /token to @BotFather, pick your bot, and paste the new token here.</p></div></div>`;
