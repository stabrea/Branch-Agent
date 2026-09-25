/* Settings › people: bind real engine data and wire controls. */
import { esc, render } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";

const hex = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c ?? "")) ? c : "#56616B");

let profiles = null;
let selectedProfile = null;

async function loadProfiles() {
  try {
    const data = await api("profiles");
    profiles = data || [];
    if (profiles.length > 0) {
      selectedProfile = profiles[0];
    }
    render();
  } catch (err) {
    console.error("Failed to load profiles:", err);
    profiles = [];
  }
}

function renderProfileList() {
  let html = `<div class="t9-list">`;

  if (profiles && profiles.length > 0) {
    const groups = {
      local: [],
      remote: [],
      team: [],
    };

    for (const p of profiles) {
      if (p.location === "local") {
        groups.local.push(p);
      } else if (p.location === "remote") {
        groups.remote.push(p);
      } else if (p.location === "team") {
        groups.team.push(p);
      }
    }

    if (groups.local.length > 0) {
      html += `<div class="grp8">On this computer</div>`;
      for (const p of groups.local) {
        const isSelected = selectedProfile && selectedProfile.id === p.id;
        const initials = esc(p.initials || String(p.name ?? "").split(" ").map((w) => w[0]).join(""));
        const color = hex(p.color);
        html += `<button type="button" class="t9-item" data-act="p-sel" data-v="${esc(p.id)}" aria-current="${isSelected}"><span class="tav6" data-css="--c:${color};width:34px;height:34px;font-size:13px">${initials}<i class="st st-${esc(p.status || "online")}"></i></span><span class="grow"><b>${esc(p.name)}${p.isOwner ? " · you" : ""}</b><small>${p.role || "User"} · last used ${p.lastUsed || "Never"}</small></span></button>`;
      }
    }

    if (groups.remote.length > 0) {
      html += `<div class="grp8">On their own device</div>`;
      for (const p of groups.remote) {
        const isSelected = selectedProfile && selectedProfile.id === p.id;
        const initials = esc(p.initials || String(p.name ?? "").split(" ").map((w) => w[0]).join(""));
        const color = hex(p.color);
        html += `<button type="button" class="t9-item" data-act="p-sel" data-v="${esc(p.id)}" aria-current="${isSelected}"><span class="tav6" data-css="--c:${color};width:34px;height:34px;font-size:13px">${initials}<i class="st st-${esc(p.status || "online")}"></i></span><span class="grow"><b>${esc(p.name)}</b><small>${p.role || "User"} · last used ${p.lastUsed || "Never"}</small></span></button>`;
      }
    }

    if (groups.team.length > 0) {
      html += `<div class="grp8">From your keepoak.com team</div>`;
      for (const p of groups.team) {
        const isSelected = selectedProfile && selectedProfile.id === p.id;
        const initials = esc(p.initials || String(p.name ?? "").split(" ").map((w) => w[0]).join(""));
        const color = hex(p.color);
        html += `<button type="button" class="t9-item" data-act="p-sel" data-v="${esc(p.id)}" aria-current="${isSelected}"><span class="tav6" data-css="--c:${color};width:34px;height:34px;font-size:13px">${initials}<i class="st st-${esc(p.status || "online")}"></i></span><span class="grow"><b>${esc(p.name)}</b><small>${p.role || "User"} · last used ${p.lastUsed || "Never"}</small></span></button>`;
      }
    }
  }

  html += `<button type="button" class="btn pri" data-css="margin-top:10px;justify-self:start" data-act="p-invite"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Invite someone</button></div>`;

  return html;
}

function renderProfileDetail() {
  if (!selectedProfile) return "";

  const initials = esc(selectedProfile.initials || String(selectedProfile.name ?? "").split(" ").map((w) => w[0]).join(""));
  const color = hex(selectedProfile.color);

  let html = `<div class="t9-detail pcard10"><div class="t9-dh"><span class="tav6" data-css="--c:${color};width:44px;height:44px;font-size:17px">${initials}<i class="st st-${esc(selectedProfile.status || "online")}"></i></span><span class="grow"><b>${esc(selectedProfile.name)}</b><small>${selectedProfile.device || "Unknown device"} · ${selectedProfile.signInMethod || "sign-in method"}</small></span><span class="pill ${selectedProfile.role?.toLowerCase() || "user"}">${selectedProfile.role || "User"}</span></div>
    <div class="sec"><h2>Permissions</h2><div class="acts10">
      ${selectedProfile.permissions ? selectedProfile.permissions.map(p => `<label class="chk ${!p.allowed ? "no10" : ""}"><input type="checkbox" ${p.allowed ? "checked" : ""} aria-label="${esc(p.name)}"> ${esc(p.name)}</label>`).join("") : ""}
    </div></div>
    <dl class="kv" data-css="margin-top:14px">
      ${selectedProfile.trunks ? `<dt>Trunks</dt><dd>${selectedProfile.trunks.join(", ")}</dd>` : ""}
      ${selectedProfile.projects ? `<dt>Projects</dt><dd>${selectedProfile.projects.join(", ")}</dd>` : ""}
      ${selectedProfile.allowance ? `<dt>Daily allowance</dt><dd>${selectedProfile.allowance}</dd>` : ""}
      ${selectedProfile.pinRequired !== undefined ? `<dt>PIN</dt><dd>${selectedProfile.pinRequired ? "Set" : "Not set"}</dd>` : ""}
      ${selectedProfile.signedInOn ? `<dt>Signed in on</dt><dd>${selectedProfile.signedInOn}</dd>` : ""}
    </dl>
    <div class="acts" data-css="margin-top:14px">
      <button class="btn sm" type="button" data-act="p-switch" data-v="${esc(selectedProfile.id)}">Switch to ${esc(selectedProfile.name)}</button>
      <span class="seg"><button type="button" data-act="p-role" data-v="Adult" aria-pressed="${selectedProfile.role === "Adult"}">Adult</button><button type="button" data-act="p-role" data-v="Child" aria-pressed="${selectedProfile.role === "Child"}">Child</button></span>
      <button class="btn ghost sm" type="button" data-act="p-code">Make a one-time code</button>
      <button class="btn ghost sm" type="button" data-act="p-signout">Sign out everywhere</button>
      <button class="btn ghost sm" type="button" data-act="p-remove">Remove</button>
    </div></div>`;

  return html;
}

export function draw() {
  let html = `<h1>People</h1><p class="lede">Everyone who uses Branch: on this computer, on their own devices, and your keepoak.com team. The same list as Team › People.</p><div class="t10">
    ${renderProfileList()}
    ${renderProfileDetail()}
  </div>
    <p class="hint">Separation on one computer, not separate accounts. Each person's conversations and memory are their own.</p>
  <div class="sec"><h2>Each person</h2><div class="ctl"><b>Ask for a PIN when switching person</b><input class="sw" type="checkbox" id="pp-pin" checked="" aria-label="Ask for a PIN when switching person" data-sw="set"><small>Four to eight digits, kept on this computer. Five wrong tries lock the profile for five minutes.</small></div><div class="ctl"><b>Keep conversations separate</b><input class="sw" type="checkbox" id="pp-own" checked="" aria-label="Keep conversations separate" data-sw="set"><small>People can't read each other's conversations unless they share one.</small></div></div>
  <div class="acts" data-css="margin-top:12px"><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="groups">Groups</button><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="signin">Signing in from other devices</button><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="shared">What you share</button></div>`;

  return html;
}

export async function load() {
  await loadProfiles();
}

export function init() {
  loadProfiles();
  on("p-sel", (el) => {
    const profileId = el.dataset.v;
    const found = profiles.find(p => p.id === profileId);
    if (found) {
      selectedProfile = found;
      render();
    }
  });
  // A person's role decides what they may do on this computer: that change waits for the security review, so it stays greyed.
  markLive(["p-sel"]);
}

export const live = {
  "p-sel": null,
};
