/* The first run, 1:1 with the prototype's shorter sequence ("Replay the first run" in the person menu): hello, how Branch
   should think, the accounts the engine has (GET /api/accounts), chat apps (GET /api/channel-setup), the two
   recommendations (the gateway through POST /api/never-break, updating by itself through POST /api/comfort), a first
   Trunk made from a job template (POST /api/trunks), and the end. Downloading a model and signing in to an account on
   its own site cannot be finished from here, so those choices stay greyed; the prototype's timed download bar is not
   drawn. Also the quiet "New to Branch?" card, shown once setup has been seen, until it is dismissed. */

import { $, esc, applyCss, onRender } from "../core/dom.js";
import { app, av, toast, ic, closePop, closeDlg } from "../core/ui.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";

const N = 8;
const TEMPLATES = [["Inbox Manager", "Clears your inbox and drafts replies in your voice", "#4F6FA8"], ["Expense Manager", "Files receipts and builds monthly reports", "#D8612A"],
  ["Researcher", "Reads the web and writes short briefs with sources", "#2F8C86"], ["Chief of Staff", "Plans your week and chases loose ends", "#56616B"]];
const F = { step: null, pick: "", accounts: [], channels: [], gw: "off", upd: "off" };

const hero = () => `<span class="mark mark-full hero-mark" aria-hidden="true"></span><h1>Hi, I’m Branch.</h1><p class="lede">I work on this computer, for you. A few quick choices and you’re done.</p><div class="acts"><button class="btn pri" type="button" data-act="fr-next">Let’s start</button><button class="btn ghost" type="button" data-act="fr-skip">Skip for now</button></div>`;
function think() {
  const ways = [["fr-way-computer", "On this computer", "Private and free."], ["fr-way-chatgpt", "Your ChatGPT account", "Sign in on their site. Uses your plan."],
    ["fr-way-claude", "Your Claude account", "Sign in on their site. Uses your plan."], ["fr-way", "Practice first", "No model yet. Try it with examples."]];
  return `<h1>How should Branch think?</h1><p class="lede">You can use several. Change it any time in Settings › Models.</p><div class="ways">${ways.map(([a, t, x]) => `<button class="way" type="button" data-act="${a}"><b>${t}</b><small>${x}</small></button>`).join("")}</div>`;
}
function accounts() {
  const rows = F.accounts.map((a) => `<button class="way" type="button" data-act="fr-acc" data-v="${esc(a.pool)}"><span data-css="display:flex;align-items:center;gap:10px">${logo(a.pool, a.label, 26)}<b>${esc(a.label)}</b></span><small>${a.signedIn ? "✓ Signed in" : "Sign in on their site"}</small></button>`).join("");
  return `<h1>Connect your accounts</h1><p class="lede">Sign in on each site. Branch never sees your passwords, and the ring bottom right will show what each one has left.</p><div class="ways">${rows}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-next">Next</button></div>`;
}
function apps() {
  const rows = F.channels.slice(0, 4).map((c) => `<button class="way" type="button" data-act="ch-open" data-v="${esc(c.id)}"><span data-css="display:flex;align-items:center;gap:10px">${logo(c.id, c.name, 26)}<b>${esc(c.name)}</b></span><small>About two minutes</small></button>`).join("");
  return `<h1>Talk to Branch from anywhere</h1><p class="lede">Connect a chat app so your Trunks can answer on your phone.</p><div class="ways">${rows}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-next">Next</button><button class="btn ghost" type="button" data-act="fr-next">Later</button></div>`;
}
function recs() {
  const row = (k, t, x, on) => `<div class="way" data-css="grid-template-columns:1fr auto;align-items:center"><span><b>${t} <span data-css="color:var(--ok)">Recommended</span></b><small data-css="display:block">${x}</small></span><input class="sw" type="checkbox" id="fr-${k}" ${on ? "checked" : ""} aria-label="${t}"></div>`;
  return `<h1>Two things we recommend</h1><div class="ways" data-css="grid-template-columns:1fr">${row("gw", "Keep your Trunks running when Branch is closed", "The gateway keeps Telegram, your phone and automations working, and restarts Branch if it stops.", F.gw === "on")}${row("upd", "Keep Branch up to date by itself", "Waits until nothing is running and keeps a safety copy first.", F.upd === "install")}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-recs">Next</button></div>`;
}
function trunk() {
  const tmpl = ([n, x, col], i) => `<button class="way" type="button" data-act="fr-tmpl" data-i="${i}"><span data-css="display:flex;align-items:center;gap:10px">${av({ kind: "trunk", color: col }, 30)}<b>${esc(n)}</b></span><small>${esc(x)}</small></button>`;
  return `<h1>Meet your first Trunk</h1><p class="lede">A Trunk is an assistant with one job. Pick one; you can make more later.</p><div class="ways">${TEMPLATES.map(tmpl).join("")}</div>`;
}
const done = () => `<h1>All set.</h1><p class="lede">${esc(F.pick || "Your Trunk")} is ready. Things to try:</p><ul class="steps-list"><li><b>Ctrl K</b> finds anything.</li></ul><div class="acts"><button class="btn pri" type="button" data-act="fr-tour">Take the 2-minute tour</button><button class="btn" type="button" data-act="fr-skip">Open Branch</button></div>`;
const STEPS = [hero, think, null, accounts, apps, recs, trunk, done];

function draw() {
  $(".first")?.remove();
  if (F.step == null) return;
  const el = Object.assign(document.createElement("div"), { className: "first" });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("window.first.label"));
  const dots = `<div class="dots" aria-hidden="true">${Array.from({ length: N }, (_, i) => `<i class="${i === F.step ? "on" : ""}"></i>`).join("")}</div>`;
  el.innerHTML = `<div class="inner">${dots}${STEPS[F.step]()}</div>`;
  applyCss(el);
  greyOut(el);
  app().appendChild(el);
  el.querySelector("button:not([aria-disabled='true'])")?.focus({ preventScroll: true });
}

/* The engine's own answers for the steps: accounts, chat apps, the gateway's mode and whether updates install by themselves. */
async function load() {
  const [acc, ch, gw, comfort] = await Promise.all([api("accounts").catch(() => ({})), api("channel-setup").catch(() => ({})), api("never-break").catch(() => ({})), api("comfort").catch(() => ({}))]);
  F.accounts = (acc.pools ?? []).flatMap((p) => (p.accounts ?? []).map((a) => ({ pool: p.pool, label: a.label || p.name || p.pool, signedIn: p.signedIn?.[a.id] === true })));
  F.channels = ch.channels ?? [];
  F.gw = gw.mode ?? "off";
  F.upd = comfort.values?.notify?.autoUpdate ?? "off";
}

export async function startFirst() {
  closePop();
  closeDlg();
  Object.assign(F, { step: 0, pick: "" });
  draw();
  await load();
  if (F.step != null) draw();
}
const go = (i) => { F.step = i === 2 ? 3 : i; draw(); };
const close = () => { F.step = null; draw(); };

/* Practice first: the old window's demo door, which finishes the first run with the engine (POST /api/onboarding). */
async function practice() {
  try { await api("onboarding", { done: true }); } catch (error) { toast(error.message); return; }
  toast("Practice mode: examples only until you choose a model.");
  go(3);
}

/* The two recommendations: each is sent only when its switch differs from what the engine has. */
async function recommend() {
  const gw = $("#fr-gw")?.checked, upd = $("#fr-upd")?.checked;
  try {
    if (gw !== (F.gw === "on")) F.gw = (await api("never-break", { mode: gw ? "on" : "off" })).mode ?? F.gw;
    if (upd !== (F.upd === "install")) F.upd = (await api("comfort", { card: "notify", values: { autoUpdate: upd ? "install" : "off" } })).values?.notify?.autoUpdate ?? F.upd;
  } catch (error) { toast(error.message); return; }
  go(F.step + 1);
}

/* Picking a job makes that Trunk (unless one by that name is there already), switching Trunks on first if they are off. */
async function makeTrunk(i) {
  const [name, description] = TEMPLATES[i];
  try {
    if (E.trunkModes.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
    if (!E.trunks.some((t) => t.name === name)) await api("trunks", { name, description });
  } catch (error) { toast(error.message); return; }
  F.pick = name;
  await refresh().catch((error) => toast(error.message));
  go(7);
}

/* ---------- "New to Branch?" ---------- */
const seen = (key) => { try { return !!localStorage.getItem(key); } catch (error) { return false; } };
function welcome() {
  if (!E.loaded || $(".welcome10") || $(".ob9") || $(".tour-layer") || !seen("branch-setup-seen") || seen("branch-welcomed")) return;
  app().insertAdjacentHTML("beforeend", `<div class="welcome10" role="region" aria-label="Welcome"><img class="pose11 wel11" src="/art/branch-wave.webp" alt="" draggable="false"><span class="grow"><b>New to Branch?</b><small>Set it up in three minutes, or take a two-minute walkthrough.</small></span><button class="btn pri sm" type="button" data-act="onboard">Set up</button><button class="btn sm" type="button" data-act="tour">Walkthrough</button><button class="icon-btn" type="button" aria-label="Dismiss" data-act="welcome-x">${ic("x", "s")}</button></div>`);
  greyOut($(".welcome10"));
}
function dismissWelcome() {
  try { localStorage.setItem("branch-welcomed", "1"); } catch (error) { toast(error.message); }
  $(".welcome10")?.remove();
}

export function init() {
  markLive(["sw:fr-gw", "sw:fr-upd", "firstrun", "fr-next", "fr-skip", "fr-tour", "fr-way", "fr-recs", "fr-tmpl", "welcome-x"]);
  on("firstrun", () => startFirst());
  on("fr-next", () => go(F.step + 1));
  on("fr-way", () => practice());
  on("fr-skip", () => close());
  on("fr-tour", () => { close(); run("tour"); });
  on("fr-recs", () => recommend());
  on("fr-tmpl", (el) => makeTrunk(+el.dataset.i));
  on("welcome-x", () => dismissWelcome());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && F.step != null) close(); });
  let checked = false;
  onRender(() => { if (!checked && E.loaded) { checked = true; setTimeout(welcome, 1200); } });
}
