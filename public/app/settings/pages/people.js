/* Settings › People, 1:1 with the prototype's card, from the engine's own list (GET /api/profiles): you, the owner,
   then everyone with a profile on this computer, each with the role and what the role lets them have Branch do
   (roles[].effective, roles[].categories). Picking a person to look at is window state. Switching person, roles,
   one-time codes, signing out and removing somebody are security-sensitive, so they are drawn greyed for review. */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";

/* The prototype's words for the engine's seven kinds (src/tool-categories.ts), in the prototype's order. */
const KINDS = [["read", "Look things up"], ["browse", "Use web pages"], ["files", "Write files"], ["commands", "Run commands"], ["message", "Send messages"], ["spend", "Spend money"], ["settings", "Change how Branch is set up"]];
const OWNER = "owner";

let data = null;
/* Who is being looked at: as in the prototype, somebody other than you when there is anybody else. */
let picked = null;

async function loadProfiles() {
  try { data = await api("profiles"); } catch (error) { toast(error.message); }
  const ids = (data?.profiles ?? []).map((p) => p.id);
  if (picked !== OWNER && !ids.includes(picked)) picked = ids[0] ?? OWNER;
  render();
}

const label = (role) => data?.roleLabels?.[role]?.label ?? "";
const roleOf = (id) => (data?.roles ?? []).find((r) => r.profileId === id);
const initials = (name) => String(name ?? "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/* Everyone on this computer: the owner first, then each profile the engine keeps. */
function people() {
  if (!data) return [];
  const owner = { id: OWNER, name: label(OWNER), role: OWNER, you: data.isOwner };
  return [owner, ...(data.profiles ?? []).map((p) => ({ id: p.id, name: p.name, role: roleOf(p.id)?.grant?.role ?? "adult", lastUsedAt: p.lastUsedAt, you: (data.active?.id ?? data.active) === p.id }))];
}

const avatar = (p, size, font) => `<span class="tav6" data-css="--c:#56616B;width:${size}px;height:${size}px;font-size:${font}px">${esc(initials(p.name))}</span>`;
const when = (at) => (at ? new Date(at).toLocaleDateString([], { weekday: "short" }) : "");

function item(p) {
  const small = [label(p.role), p.lastUsedAt ? `last used ${when(p.lastUsedAt)}` : ""].filter(Boolean).join(" · ");
  return `<button type="button" class="t9-item" data-act="p-sel" data-v="${esc(p.id)}" aria-current="${picked === p.id}">${avatar(p, 34, 13)}<span class="grow"><b>${esc(p.name)}${p.you ? " · you" : ""}</b><small>${esc(small)}</small></span></button>`;
}

function list(all) {
  return `<div class="t9-list">${all.length ? `<div class="grp8">On this computer</div>${all.map(item).join("")}` : ""}<button type="button" class="btn pri" data-css="margin-top:10px;justify-self:start" data-act="p-invite"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Invite someone</button></div>`;
}

/* What the person may have Branch do: the engine's effective kinds for a profile, every kind for the owner. */
function mayRows(p) {
  const kinds = p.id === OWNER ? KINDS.map(([k]) => k) : roleOf(p.id)?.categories ?? [];
  return KINDS.map(([k, l]) => { const yes = kinds.includes(k); return `<label class="chk ${yes ? "" : "no10"}"><input type="checkbox" ${yes ? "checked" : ""} disabled aria-label="${esc(l)}"> ${esc(l)}</label>`; }).join("");
}

function facts(p) {
  if (p.id === OWNER) return `<dt>Trunks</dt><dd>All</dd><dt>Projects</dt><dd>All</dd><dt>Daily allowance</dt><dd>No limit</dd><dt>PIN</dt><dd>${data.ownerPin ? "Set" : "—"}</dd>`;
  const g = roleOf(p.id)?.effective ?? roleOf(p.id)?.grant ?? {};
  const projects = (g.projects ?? []).length ? g.projects.join(", ") : "All";
  const allowance = g.dailySpendLimit > 0 ? `$${g.dailySpendLimit} a day` : "No limit";
  return `<dt>Projects</dt><dd>${esc(projects)}</dd><dt>Daily allowance</dt><dd>${esc(allowance)}</dd><dt>PIN</dt><dd>Set</dd>`;
}

function actions(p) {
  if (p.id === OWNER) return '<p class="hint">You’re the owner. Only you change how Branch is set up.</p>';
  const first = String(p.name ?? "").split(" ")[0];
  const roles = ["adult", "child"].map((r) => `<button type="button" data-act="p-role" data-v="${r}" aria-pressed="${p.role === r}">${esc(label(r))}</button>`).join("");
  return `<div class="acts" data-css="margin-top:14px"><button class="btn sm" type="button" data-act="p-switch" data-v="${esc(p.id)}">Switch to ${esc(first)}</button><span class="seg">${roles}</span><button class="btn ghost sm" type="button" data-act="p-code">Make a one-time code</button><button class="btn ghost sm" type="button" data-act="p-signout">Sign out everywhere</button><button class="btn ghost sm" type="button" data-act="p-remove">Remove</button></div>`;
}

function card(p) {
  if (!p) return "";
  const where = p.id === OWNER ? "This computer" : "This computer · PIN";
  return `<div class="t9-detail pcard10"><div class="t9-dh">${avatar(p, 44, 17)}<span class="grow"><b>${esc(p.name)}</b><small>${where}</small></span><span class="pill ${p.role === OWNER ? "ok" : "idle"}">${esc(label(p.role))}</span></div>
    <div class="sec"><h2>May</h2><div class="acts10">${mayRows(p)}</div></div>
    <dl class="kv" data-css="margin-top:14px">${facts(p)}</dl>${actions(p)}</div>`;
}

/* Both are how the engine always works (greyed: PINs are for review): a profile cannot be made without a PIN
   (ProfileSchema), and each profile's records are its own (profiles.scope()). */
function eachPerson() {
  const pin = '<input class="sw" type="checkbox" id="pp-pin" checked aria-label="Ask for a PIN when switching person" data-sw="set">'; // state: every profile has a PIN
  const own = '<input class="sw" type="checkbox" id="pp-own" checked aria-label="Keep conversations separate" data-sw="set">'; // state: each profile's records are its own
  return `<div class="sec"><h2>Each person</h2><div class="ctl"><b>Ask for a PIN when switching person</b>${pin}<small>Four to eight digits, kept on this computer. Five wrong tries lock the profile for five minutes.</small></div><div class="ctl"><b>Keep conversations separate</b>${own}<small>People can’t read each other’s conversations unless they share one.</small></div></div>`;
}

export function draw() {
  const all = people();
  return `<h1>People</h1><p class="lede">Everyone who uses Branch: on this computer, on their own devices, and your keepoak.com team. The same list as Team › People.</p><div class="t10">
    ${list(all)}${card(all.find((p) => p.id === picked))}</div>
    <p class="hint">Separation on one computer, not separate accounts. Each person’s conversations and memory are their own.</p>
  ${eachPerson()}
  <div class="acts" data-css="margin-top:12px"><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="groups">Groups</button><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="signin">Signing in from other devices</button><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="shared">What you share</button></div>`;
}

export function load() { return loadProfiles(); }

export function init() {
  loadProfiles();
  on("p-sel", (el) => { picked = el.dataset.v; render(); });
  markLive(["p-sel"]);
}

export const live = { "p-sel": true };
