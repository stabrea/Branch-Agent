/* Settings › Saved sign-ins: the sign-ins the owner said Branch may fill (GET /api/vault-autofill/settings), never a
   password. Remove takes one off that list (POST /api/vault-autofill/settings { logins }, which replaces the list, so the
   rest are sent back as they were). The status line is shown only when the engine has Bitwarden set up as a service
   (GET /api/credentials/settings). */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast, ic } from "../../core/ui.js";
import { secrets17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";

const MASK = "••••••••";
let vault = null;
let credentials = null;

async function loadAll() {
  const [v, c] = await Promise.all(["vault-autofill/settings", "credentials/settings"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  vault = v; credentials = c;
  render();
}

async function remove(name) {
  const logins = (vault?.logins ?? []).filter((x) => x.name !== name);
  try { await api("vault-autofill/settings", { logins }); toast(`${name} removed from what Branch may fill.`); } catch (error) { toast(error.message); }
  await loadAll();
}

export function init() {
  on("secret-rm", (el) => remove(el.dataset.name));
  markLive(["secret-rm"]);
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "secret-rm": true };

function rows() {
  return (vault?.logins ?? []).map((s) => `<div class="prow"><span class="ico-tile">${ic("key", "s")}</span><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.site)}</small></span><span class="meta">${MASK}</span><button class="btn ghost sm" type="button" data-act="secret-rm" data-name="${esc(s.name)}">Remove</button></div>`).join("");
}

export function draw() {
  const bitwarden = credentials?.enabled && (credentials.services ?? []).includes("bitwarden");
  const status = bitwarden ? `<div class="status"><span class="sdot "></span><div><b>Bitwarden is connected</b><p>Branch asks Bitwarden to fill a sign-in; you approve each one the first time.</p></div></div>` : "";
  return `<h1>Saved sign-ins</h1><p class="lede">Sign-ins Branch may fill for you. It never sees or stores the passwords.</p>${status}<div class="sec"><h2>Branch may fill</h2><div class="rows">${rows()}</div></div>${secrets17(level17(), credentials?.services)}`;
}
