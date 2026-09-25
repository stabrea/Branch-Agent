/* Settings › secrets: bind saved sign-ins from the engine. Never show secret values.  */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { esc } from "../../core/dom.js";

const MASK = "••••••••";

function secretsSection(secrets) {
  if (!secrets || secrets.length === 0) {
    return `<div class="sec"><h2>Branch may fill</h2><p class="hint">No saved sign-ins yet.</p></div>`;
  }

  const rows = secrets
    .map((s, i) => {
      const name = esc(s.name ?? "");
      const host = esc(s.host ?? "");
      return `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="M11 12.5l8-8M16 7.5l2.5 2.5"></path></svg></span><span class="grow"><b>${name}</b><small>${host}</small></span><span class="meta">${MASK}</span><button class="btn ghost sm" type="button" data-act="secret-rm" data-i="${i}">Remove</button></div>`;
    })
    .join("");

  return `<div class="sec"><h2>Branch may fill</h2><div class="rows">${rows}</div></div>`;
}

const BASE = `<h1>Saved sign-ins</h1><p class="lede">Sign-ins Branch may fill for you. It never sees or stores the passwords.</p><div class="status"><span class="sdot "></span><div><b>Bitwarden is connected</b><p>Branch asks Bitwarden to fill a sign-in; you approve each one the first time.</p></div></div>`;

export function draw() {
  const secrets = E.state?.secrets ?? [];
  return BASE + secretsSection(secrets);
}

export const live = { "secret-rm": true };
