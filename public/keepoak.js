/**
 * Issue #105, slice 1: KeepOak inside Branch. One card under Settings › Accounts with one switch,
 * off as it ships. On (in the desktop app) there is a KeepOak entry in the sidebar that opens
 * keepoak.com in a locked window of its own (src/desktop/keepoak-view.ts). Switching it off closes
 * that window; only Sign out forgets the KeepOak sign-in on this computer. Nothing here talks to
 * keepoak.com.
 */
import { t } from "/i18n.js";
import { switchControl } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const desktop = () => window.branchDesktop?.openKeepOak ? window.branchDesktop : null;
async function api(body) {
  const response = await fetch("/api/keepoak", {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
/** An element whose words follow a language change (data-t). */
function worded(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

let on = false;
async function openKeepOak(status) {
  try { await desktop().openKeepOak(); } catch (error) { if (status) status.textContent = error.message; }
}

function railEntry() {
  $("keepoak-rail")?.remove();
  const nav = $("sections-nav");
  if (!on || !desktop() || !nav) return;
  const row = document.createElement("button");
  row.type = "button";
  row.id = "keepoak-rail";
  row.className = "lx-place-link keepoak-rail";
  const mark = Object.assign(document.createElement("img"), { src: "/assets/keepoak-mark.png", alt: "" });
  mark.className = "keepoak-mark";
  row.append(mark, worded("span", "keepoak.rail", "lx-words"));
  row.addEventListener("click", () => void openKeepOak(null));
  nav.append(row);
}

function card() {
  $("keepoak-card")?.remove();
  const node = document.createElement("section");
  node.className = "card keepoak-card";
  node.id = "keepoak-card";
  node.dataset.home = "settings:accounts";
  node.append(worded("h2", "keepoak.title"), worded("p", "keepoak.intro", "subtle"));
  const row = document.createElement("div");
  row.className = "capability-row";
  const label = worded("label", "keepoak.switch");
  label.htmlFor = "keepoak-on";
  const note = worded("p", "keepoak.switch-note", "field-note");
  note.id = "keepoak-on-note";
  const status = document.createElement("p");
  status.className = "field-note";
  status.setAttribute("role", "status");
  const control = switchControl({ id: "keepoak-on", checked: on, onChange: async (next) => {
    try {
      on = (await api({ on: next })).on;
      render();
      $("keepoak-on")?.focus(); // drawn again, so the keyboard stays on the switch
      // Off closes KeepOak's window at once; a window that could not be closed is said, not hidden.
      if (!on) await desktop()?.closeKeepOak?.().catch((error) => {
        const said = $("keepoak-card")?.querySelector('[role="status"]');
        if (said) said.textContent = t("keepoak.not-closed", { why: error.message });
      });
    } catch (error) { control.checked = !next; status.textContent = error.message; }
  } });
  control.setAttribute("aria-describedby", note.id);
  row.append(label, control);
  node.append(row, note);
  if (on && desktop()) {
    const actions = document.createElement("div");
    actions.className = "identity-actions";
    const open = worded("button", "keepoak.open");
    open.type = "button";
    open.id = "keepoak-open";
    open.addEventListener("click", () => void openKeepOak(status));
    const out = worded("button", "keepoak.signout", "quiet");
    out.type = "button";
    out.id = "keepoak-signout";
    out.addEventListener("click", async () => {
      try { await desktop().disconnectKeepOak(); status.textContent = t("keepoak.signed-out"); } catch (error) { status.textContent = error.message; }
    });
    actions.append(open, out);
    node.append(actions);
  } else if (on) node.append(worded("p", "keepoak.desktop-only", "field-note"));
  node.append(status);
  document.body.append(node);
}

function render() { card(); railEntry(); }

export async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { on = (await api()).on === true; } catch { on = false; }
  render();
  // The sidebar is drawn by public/layout.js; the entry joins it once it is there.
  for (let tries = 0; tries < 50 && on && desktop() && !$("keepoak-rail"); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    railEntry();
  }
}
globalThis.branchKeepOak = { refresh };
/* On a fresh window the key is not there yet, so it is read again once the owner is in, and again
   whenever the window becomes the owner's (household-followups). */
void refresh();
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void refresh(); })
  .observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
document.addEventListener("branch-profile", (event) => { if (event.detail?.owner) void refresh(); else { on = false; render(); } });
