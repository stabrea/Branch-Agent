/* Set up Branch (design doc 6.1): the eleven steps drawn 1:1 from design/redesign/dom/setup-0..10.html, against
   the engine: models from GET /api/accounts and /api/local-models, a hello through POST /api/models/test, the look,
   how much it asks (POST /api/conversation-mode/settings), Trunks made with POST /api/trunks, chat apps from
   GET /api/channel-setup, the gateway (POST /api/never-break), and the engine's own checks (GET /api/health).
   Choices the engine cannot act on yet keep their place and are greyed out. */

import { $, esc, applyCss } from "../core/dom.js";
import { ic, app, toast } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";

const STEPS = ["Welcome", "Where Branch runs", "Models", "Make it yours", "Your first Trunks", "Reach it anywhere", "Tools",
  "Keep it running", "People", "Two more things", "Health check"];
const POSES = [null, "point", "think", null, "work", "mail", "work", "sleep", "wave", null, "yay"];
const TEMPLATES = [
  ["Inbox Manager", "Clears your inbox and drafts replies in your voice", "#4F6FA8"],
  ["Expense Manager", "Files receipts and builds monthly reports", "#D8612A"],
  ["Researcher", "Reads the web and writes short briefs with sources", "#2F8C86"],
  ["Chief of Staff", "Plans your week and chases loose ends", "#56616B"],
  ["Bug Reproduction", "Turns a bug report into exact steps", "#B84A6B"],
  ["Trip Planner", "Finds and books refundable travel", "#8A5AA8"],
];
const POPULAR = 9;

const mac = () => app()?.dataset.surface === "mac";
const pressed = (on) => `aria-pressed="${on}"`;
const pose = (i) => POSES[i] ? `<img class="pose11 ob-pose11" src="/art/branch-${POSES[i]}.webp" alt="" loading="lazy" decoding="async" draggable="false">` : "";
const prov = (act, k, v, icon, name, sub, on) =>
  `<button class="prov" type="button" data-act="${act}" data-k="${k}" data-v="${v}" ${pressed(on)}><span class="ico-tile">${ic(icon, "s")}</span><b>${name}</b><small>${sub}</small></button>`;
const ctl = (id, name, sub) => `<div class="ctl"><b>${name}</b><input class="sw" type="checkbox" id="${id}" aria-label="${name}" data-sw="set"><small>${sub}</small></div>`;

function welcome(o) {
  return `<div class="ob-stage11"><video class="pose11 vid11 ob-art11" src="/art/anim-idle.webm" poster="/art/branch-wave.webp" muted loop autoplay playsinline aria-hidden="true"></video></div><h2>Hi, I’m Branch.</h2><p>An assistant that lives on this computer, with Trunks that each take one job. This takes about three minutes; you can change everything later.</p><div class="ob-trust"><b>How Branch stays safe</b><ul class="may6"><li>${ic("check", "s")}It asks before it sends, deletes, spends or installs anything.</li><li>${ic("check", "s")}Your conversations and keys stay on your computers.</li><li>${ic("check", "s")}You can take over, stop it, or roll back any change.</li></ul><label class="chk"><input type="checkbox" id="ob-trust" ${o.trust ? "checked" : ""}> I understand Branch can act on this computer when I allow it</label></div>`;
}

function where(o) {
  return `<h2 tabindex="-1">Where should Branch run?</h2><p>The engine and the gateway live here. You can talk to it from anywhere.</p><div class="provs">
    ${prov("ob-set", "where", "this", "monitor", "This computer", "Recommended. Private, free, fast.", o.where === "this")}
    ${prov("ob-where-remote", "where", "remote", "key", "Another computer", "Over Tailscale or SSH: a home server or a desk PC.", false)}
    ${prov("ob-where-keepoak", "where", "keepoak", "globe", "A KeepOak computer", "In the cloud, always on. Needs a keepoak.com account.", false)}
    ${prov("ob-set", "where", "later", "clock", "Decide later", "Start here and move it any time.", o.where === "later")}</div>`;
}

function modelRows(o) {
  const rows = [];
  for (const p of o.pools) for (const a of p.accounts ?? []) rows.push([p.pool, a.label || p.pool, p.pool + (p.defaultAccount === a.id ? " · used next" : "")]);
  for (const m of o.local) rows.push(["ollama", `${m.name ?? m.model ?? m}, on this computer`, "Ollama"]);
  if (!rows.length && E.state?.activeModel) rows.push([E.state.activeModel.presetName, E.state.activeModel.presetName, E.state.activeModel.model ?? ""]);
  return rows.map(([id, name, sub], i) => `<div class="prow">${logo(id, name, 30)}<span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span><input class="sw" type="checkbox" data-sw="ob-brain" data-i="${i}" aria-label="${esc(name)}"></div>`).join("");
}

function testOut(o) {
  const t = o.test;
  if (!t) return "";
  if (t === "wait") return `<div class="status"><span class="sdot"></span><div><b>Saying hello…</b></div></div>`;
  if (!t.ok) return `<div class="status"><span class="sdot bad"></span><div><b>It did not answer</b><p>${esc(t.error ?? t.reply ?? "")}</p></div></div>`;
  return `<div class="status"><span class="sdot"></span><div><b>It answered in ${(t.ms / 1000).toFixed(1)} s</b><p>“${esc(t.reply)}” · ${esc(t.presetName)}</p></div></div>`;
}

function models(o) {
  return `<h2 tabindex="-1">Which models should answer?</h2><p>Found on this computer:</p><div class="rows">${modelRows(o)}</div><div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="addacct">${ic("plus", "s")}Add another account</button><button class="btn sm" type="button" data-act="ob-test">Say hello to test it</button></div><div id="ob-test-out">${testOut(o)}</div>`;
}

/* Auto lets workspace changes go ahead and keeps a standing yes per website (src/conversation-mode.ts), which loosens
   the default Ask first, so it has its own act name and stays greyed until it is reviewed. */
function yours(o) {
  const look = document.documentElement.dataset.theme || "system";
  const looks = [["system", mac() ? "Match Mac" : "Match Windows"], ["light", "Light"], ["dark", "Dark"]];
  const asks = [["auto", "spark", "Auto", "Branch decides what’s safe and only asks about risky things."], ["ask", "shield", "Ask first", "Always asks before changing files, running commands or using the internet."], ["plan", "list15", "Plan first", "Writes a plan and waits for your OK before doing anything."]];
  return `<h2 tabindex="-1">Make it yours</h2><p>Two quick choices. Both can change any time in Settings.</p>
    <div class="ob-q15"><b>How it looks</b><div class="ob-pick15">${looks.map(([v, l]) => `<button type="button" class="ob-card15 look-${v}" data-act="ob15" data-k="look" data-v="${v}" ${pressed(look === v)}><span class="ob-sw15"><i></i><i></i><i></i></span>${l}</button>`).join("")}</div></div>
    <div class="ob-q15"><b>How much it asks</b><div class="ob-pick15 col15x">${asks.map(([v, i, l, s]) => `<button type="button" class="ob-row15" data-act="${v === "auto" ? "ob15-auto" : "ob15"}" data-k="asks" data-v="${v}" ${pressed(o.asks === v)}><span class="ico-tile">${ic(i, "s")}</span><span><b>${l}</b><small>${s}</small></span></button>`).join("")}</div><p class="hint" data-css="margin:6px 0 0">Full access stays off until you turn it on yourself.</p></div>`;
}

function trunks(o) {
  const made = new Set(E.trunks.map((t) => t.name));
  return `<h2 tabindex="-1">Your first Trunks</h2><p>Pick a few, or tell Branch about your life and work and it proposes them.</p><div class="ob-tr">${TEMPLATES.map(([n, s, col], i) => `<button class="ob-tpl" type="button" data-act="ob-tpl" data-i="${i}" ${pressed(o.tpls.has(i) || made.has(n))}><span class="ob-dot" data-css="background:${col}"></span><b>${n}</b><small>${s}</small></button>`).join("")}</div><label class="fld" data-css="margin-top:12px"><span>Or describe what you do</span><textarea class="inp" id="ob-life" rows="2" placeholder="I’m a finance student with a part-time job at Hartwell. I travel a lot."></textarea></label><button class="btn sm" type="button" data-act="ob-propose">${ic("spark", "s")}Let Branch propose Trunks</button>${o.error ? `<p class="hint" role="alert">${esc(o.error)}</p>` : ""}`;
}

function reach(o) {
  const live = new Set((o.connected ?? []).flatMap((c) => [c.id, c.kind]));
  const tiles = o.channels.slice(0, POPULAR).map((c) => `<button type="button" class="ch12 ${live.has(c.id) ? "on12" : ""}" data-act="ch-open" data-v="${esc(c.id)}">${logo(c.id, c.name, 30)}<span><b>${esc(c.name)}</b><small>${live.has(c.id) ? "Connected" : "Set up"}</small></span></button>`).join("");
  return `<h2 tabindex="-1">Reach Branch anywhere</h2><p>Message your Trunks from the apps you already use. ${o.channels.length} to choose from; here are the popular ones.</p><div class="ch-grid12 ob-ch12">${tiles}</div><div class="prow" data-css="margin-top:12px"><span class="ico-tile">${ic("phone", "s")}</span><span class="grow"><b>Your phone</b><small>Scan the square code with the Branch app</small></span><button class="btn sm" type="button" data-act="pair">Show the code</button></div>`;
}

function tools(o) {
  const found = o.servers.map((s) => [s.id ?? s.name, s.name ?? s.id, s.description ?? ""]);
  const rows = found.length ? found : [["outlook", "Outlook", "Mail and calendar · sign in on their site"], ["drive", "Google Drive", "Documents · sign in on their site"], ["github", "GitHub", "Code and issues · sign in on their site"]];
  return `<h2 tabindex="-1">Tools to start with</h2><p>Recommended for the Trunks you picked. Everything else is under the plug.</p><div class="rows">${rows.map(([id, n, s]) => `<div class="prow">${logo(id, n, 28)}<span class="grow"><b>${esc(n)}</b><small>${esc(s)}</small></span><input class="sw" type="checkbox" data-sw="set" aria-label="${esc(n)}"></div>`).join("")}</div>`;
}

function keep(o) {
  const seg = [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]].map(([v, l]) => `<button type="button" ${pressed(o.gw === v)} data-act="ob-gw" data-v="${v}">${l}</button>`).join("");
  return `<h2 tabindex="-1">Keep it running</h2><div class="ctl"><b>The gateway</b><span class="right"><span class="seg" role="group" aria-label="The gateway">${seg}</span></span><small>Keeps Telegram, your phone and automations working when the window is closed, and starts Branch again if it ever stops.</small></div>${ctl("ob-boot", mac() ? "Start with your Mac" : "Start with Windows", mac() ? "Quietly, in the menu bar." : "Quietly, in the tray.")}${ctl("ob-upd", "Keep Branch up to date by itself", "It waits until no task is working and keeps a safety copy.")}${o.gwNote ? `<p class="hint">${esc(o.gwNote)}</p>` : ""}`;
}

function people() {
  return `<h2 tabindex="-1">Anyone else?</h2><p>People on this computer, teammates on theirs, or your keepoak.com team. Skip it if it’s just you.</p><div class="provs">
    ${prov("ob-people-local", "people", "local", "users", "Someone on this computer", "A household profile with its own PIN", false)}
    ${prov("ob-people-invite", "people", "invite", "chat", "A teammate on their computer", "An invite link or a six-digit code", false)}
    ${prov("ob-people-keepoak", "people", "keepoak", "globe", "Your keepoak.com team", "Everyone in your workspace", false)}</div>`;
}

function more() {
  return `<h2 tabindex="-1">Two more things</h2><p>Both optional. Skip them and Branch works the same.</p>
    <div class="ob-two15"><div class="tile"><div class="th"><span class="ico-tile">${ic("mail", "s")}</span><b>Email and calendar</b></div><p>So Trunks can find invoices, draft replies and see when you’re free. They still ask before sending.</p><div class="acts"><button class="btn sm" type="button" data-act="ob-mail">${logo("outlook", "Outlook", 16)}Outlook</button><button class="btn sm" type="button" data-act="ob-mail">${ic("mail", "s")}Gmail</button></div></div>
    <div class="tile"><div class="th"><span class="ico-tile">${ic("clock", "s")}</span><b>Bring back your Branch</b></div><p>Moving from another computer? Restore Trunks, memory and automations from a backup.</p><div class="acts"><button class="btn sm" type="button" data-act="ob-restore">${ic("folder", "s")}Choose a backup…</button></div></div></div>`;
}

function check(o) {
  return `<h2>All set?</h2><p>Branch checks everything before you start.</p><ol class="tl ob-checks">${o.checks.map((c) => `<li class="${c.ok === true ? "ok" : ""}">${c.ok == null ? ic("spin", "s spin") : ic(c.ok ? "check" : "x", "s")}<span>${esc(c.name)}<small>${c.ok == null ? "checking…" : esc(c.said)}</small></span></li>`).join("")}</ol>`;
}

const BODIES = [welcome, where, models, yours, trunks, reach, tools, keep, people, more, check];

function frame(o) {
  const i = o.i, last = i === STEPS.length - 1;
  const rail = STEPS.map((l, j) => `<li class="${j < i ? "done" : j === i ? "now" : ""}"><button type="button" data-act="ob-go" data-v="${j}" ${j > i && !o.trust ? "disabled" : ""}><em>${j < i ? ic("check", "s") : j + 1}</em>${l}</button></li>`).join("");
  const done = o.checks.filter((c) => c.ok != null).length;
  const next = !last ? `<button class="btn pri" type="button" data-act="ob-next" ${i === 0 && !o.trust ? "disabled" : ""}>${i === 0 ? "Start" : "Continue"}</button>`
    : `<button class="btn pri" type="button" data-act="ob-done" ${done < o.checks.length ? "disabled" : ""}>${done < o.checks.length ? `Checking… ${done} of ${o.checks.length}` : "Open Branch and take the walkthrough"}</button>`;
  return `<aside class="ob-rail"><span class="ob-brand"><span class="mark mark-face" data-css="width:26px;height:26px"></span>Set up Branch</span><ol>${rail}</ol><button class="link ob-skip" type="button" data-act="ob-close">Skip for now</button></aside>
    <section class="ob-main"><div class="ob-body">${pose(i)}${BODIES[i](o)}</div><footer class="ob-foot">${i ? `<button class="btn ghost" type="button" data-act="ob-go" data-v="${i - 1}">Back</button>` : "<span></span>"}<span class="grow"></span>${next}</footer></section>`;
}

function draw() {
  const o = S.ob;
  if (!o) return;
  let el = $(".ob9");
  const fresh = !el;
  if (fresh) {
    el = document.createElement("div");
    el.className = "ob9";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("window.setup.label"));
    app().appendChild(el);
  } else el.classList.add("ob-still12");
  el.innerHTML = frame(o);
  applyCss(el);
  greyOut(el);
  if (!fresh) el.querySelector("h2")?.focus({ preventScroll: true });
}

async function load(o) {
  const [accounts, local, channels, connected, mcp, gw, mode] = await Promise.all([
    api("accounts").catch(() => ({})), api("local-models").catch(() => ({})), api("channel-setup").catch(() => ({})),
    api("channels").catch(() => ({})), api("mcp/connections").catch(() => ({})), api("never-break").catch(() => ({})),
    api("conversation-mode/settings").catch(() => ({})),
  ]);
  Object.assign(o, {
    pools: accounts.pools ?? [], local: local.ollama?.models ?? [], channels: channels.channels ?? [], connected: connected.channels ?? [],
    servers: mcp.servers ?? [], gw: gw.mode ?? o.gw, asks: ["auto", "ask", "plan"].includes(mode.settings?.newConversation) ? mode.settings.newConversation : "ask",
  });
}

export async function openSetup() {
  S.ob = { i: 0, trust: false, where: "this", pools: [], local: [], channels: [], connected: [], servers: [], gw: "off", asks: "ask", tpls: new Set(), test: null, checks: [], error: "", gwNote: "" };
  draw();
  await load(S.ob).catch(() => {});
  draw();
}

function close() {
  $(".ob9")?.remove();
  S.ob = null;
  try { localStorage.setItem("branch-setup-seen", "1"); } catch { /* private window */ }
}

/* Leaving "Your first Trunks" makes each picked template a Trunk, skipping names that already exist. Picking one is
   asking for Trunks, so they are switched on first if they are off. */
async function makeTrunks(o) {
  if (E.trunkModes.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
  const have = new Set(E.trunks.map((t) => t.name));
  for (const i of o.tpls) {
    const [name, description] = TEMPLATES[i];
    if (!have.has(name)) await api("trunks", { name, description });
  }
  o.tpls.clear();
  await refresh().catch(() => {});
}

async function go(i) {
  const o = S.ob;
  if (!o || i < 0 || i >= STEPS.length || (i > 0 && !o.trust)) return;
  if (o.i === 4 && o.tpls.size) {
    try { await makeTrunks(o); o.error = ""; } catch (error) { o.error = error.message; draw(); return; }
  }
  o.i = i;
  draw();
  if (i === STEPS.length - 1) runChecks(o);
}

async function timed(fn) {
  const t = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - t)];
}

/* The engine's own answers only: how fast it replies, a hello from the default model, the gateway, and three of
   GET /api/health's checks. Each row settles as its check comes back. */
async function runChecks(o) {
  const HEALTH = ["Channels", "Saved data", "Device key"];
  o.checks = [{ name: "The engine" }, { name: "Models" }, { name: "The gateway" }, ...HEALTH.map((name) => ({ name }))];
  draw();
  const settle = (n, ok, said) => { if (S.ob !== o) return; Object.assign(o.checks[n], { ok, said }); draw(); };
  const [health, ms] = await timed(() => api("health")).catch(() => [null, 0]);
  settle(0, !!health, health ? `answering in ${ms} ms` : "not answering");
  const test = await api("models/test", {}).catch((error) => ({ ok: false, error: error.message }));
  o.checks[1].name = test.presetName || "Models";
  settle(1, !!test.ok, test.ok ? `answered in ${(test.ms / 1000).toFixed(1)} s` : test.error ?? "did not answer");
  const gw = await api("never-break").catch(() => null);
  settle(2, !!gw, gw ? ({ off: "off", "when-needed": "when needed", on: "on" }[gw.mode] ?? gw.mode) : "not answering");
  HEALTH.forEach((name, j) => {
    const item = health?.items?.find((x) => x.name === name);
    settle(3 + j, item ? item.ok : false, item?.summary ?? "not checked");
  });
}

async function finish() {
  try {
    await api("onboarding", { done: true });
  } catch (error) {
    toast(error.message);
    return;
  }
  close();
  await refresh().catch(() => {});
  toast("Branch is ready. Here’s the two-minute walkthrough.");
  setTimeout(() => run("tour"), 700);
}

async function test() {
  const o = S.ob;
  o.test = "wait";
  draw();
  o.test = await api("models/test", {}).catch((error) => ({ ok: false, error: error.message }));
  if (S.ob === o) draw();
}

async function saveAsks(v) {
  const o = S.ob;
  try { await api("conversation-mode/settings", { newConversation: v }); o.asks = v; } catch (error) { toast(error.message); }
  draw();
}

async function saveGateway(v) {
  const o = S.ob;
  try { const view = await api("never-break", { mode: v }); o.gw = view.mode ?? v; o.gwNote = view.note ?? ""; } catch (error) { toast(error.message); }
  draw();
}

export function init() {
  markLive(["sw:ob-trust", "onboard", "ob-go", "ob-next", "ob-close", "ob-done", "ob-set", "ob-test", "ob15", "ob-tpl", "ob-gw"]);
  on("onboard", () => openSetup());
  on("ob-go", (el) => go(+el.dataset.v));
  on("ob-next", () => go(S.ob.i + 1));
  on("ob-close", () => close());
  on("ob-done", () => finish());
  on("ob-set", (el) => { S.ob[el.dataset.k] = el.dataset.v; draw(); });
  on("ob-test", () => test());
  on("ob15", (el) => { if (el.dataset.k === "look") { run("themeset", el); draw(); } else saveAsks(el.dataset.v); });
  on("ob-tpl", (el) => { const i = +el.dataset.i; if (S.ob.tpls.has(i)) S.ob.tpls.delete(i); else S.ob.tpls.add(i); draw(); });
  on("ob-gw", (el) => saveGateway(el.dataset.v));
  document.addEventListener("change", (e) => { if (e.target.id === "ob-trust" && S.ob) { S.ob.trust = e.target.checked; draw(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.ob && !document.querySelector(".scrim")) close(); });
}
