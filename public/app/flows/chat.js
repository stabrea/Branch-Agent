/* Chat app wizard: connect messaging services like Telegram, Slack, Discord. */

import { esc, applyCss } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

export function init() {
  markLive(["ch-open", "chw-next", "chw-back", "chw-save", "chf-eye"]);
  on("ch-open", (el) => openChatWizard(el.dataset.v));
  on("chw-next", () => { if (S.chw) S.chw.step++; drawChatWizard(); });
  on("chw-back", () => { if (S.chw) S.chw.step = Math.max(0, S.chw.step - 1); drawChatWizard(); });
  on("chw-save", () => saveChatApp());
  on("chf-eye", (el) => {
    const field = document.querySelector(`[data-chf="${el.dataset.k}"]`);
    if (field) field.type = field.type === "password" ? "text" : "password";
  });
}

export function openChatWizard(id) {
  S.chw = { id, step: 0, fields: {} };
  drawChatWizard();
}

async function drawChatWizard() {
  const ch = S.chw;
  if (!ch) return;

  const body = `<p>Set up {{service}}. Follow the steps to create a bot and link it to Branch.</p>
    <ol style="margin:16px 0;padding-left:20px">
      <li>Create the bot on the service's website</li>
      <li>Paste the token or code</li>
      <li>Check that the connection works</li>
      <li>Pair or configure who answers</li>
      <li>Save and start using it</li>
    </ol>`;

  openDlg({
    title: `Set up ${esc(ch.id || "chat app")}`,
    body,
    foot: '<button class="btn pri" type="button" data-act="dlg-close">Close</button>'
  });
}

function saveChatApp() {
  S.chw = null;
  closeDlg();
  toast("Chat app connected.");
}
