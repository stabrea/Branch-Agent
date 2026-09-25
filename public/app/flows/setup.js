/* Setup wizard: 11-step onboarding for first-time users. */

import { $, $$, esc, paint, applyCss } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { S, E, save } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { render } from "../core/dom.js";

const OB_STEPS = [
  { title: "Welcome", key: "welcome" },
  { title: "Where", key: "where" },
  { title: "Models", key: "models" },
  { title: "Look", key: "look" },
  { title: "Trunks", key: "trunks" },
  { title: "Reach", key: "reach" },
  { title: "Tools", key: "tools" },
  { title: "Gateway", key: "gateway" },
  { title: "People", key: "people" },
  { title: "More", key: "more" },
  { title: "Health check", key: "check" }
];

export function init() {
  markLive(["onboard", "ob-go", "ob-next", "ob-close", "ob-done", "ob-set"]);
  on("onboard", () => openSetup());
  on("ob-go", (el) => { if (S.ob) { S.ob.i = +el.dataset.v; drawSetup(); } });
  on("ob-next", () => { if (S.ob) { S.ob.i = Math.min(S.ob.i + 1, OB_STEPS.length - 1); drawSetup(); } });
  on("ob-close", () => closeSetup());
  on("ob-done", () => finishSetup());
  on("ob-set", (el) => {
    if (S.ob && el.dataset.k && el.dataset.v) {
      S.ob[el.dataset.k] = el.dataset.v;
      drawSetup();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.ob) closeSetup();
  });
}

export function openSetup() {
  S.ob = S.ob || { i: 0, trust: false, where: "this", models: [true, true], trunks: [], gw: "on", checked: 0 };
  drawSetup();
}

function drawSetup() {
  const ob = S.ob, step = OB_STEPS[ob.i];
  if (!step) return;

  const rail = `<aside class="ob-rail">
    <div class="ob-head" data-css="font-weight:600;font-size:16px;padding:16px 12px">
      Set up Branch
    </div>
    <ol class="ob-steps" data-css="list-style:none;padding:12px;margin:0">
      ${OB_STEPS.map((s, i) => `<li data-css="margin-bottom:8px">
        <button type="button" data-act="ob-go" data-v="${i}" ${i > ob.i && !ob.trust ? 'aria-disabled="true"' : ''} ${i === ob.i ? 'aria-current="step"' : ''}>
          ${i < ob.i ? '<span data-css="margin-right:8px">✓</span>' : '<span data-css="margin-right:8px">' + (i + 1) + '</span>'}
          ${esc(s.title)}
        </button>
      </li>`).join("")}
    </ol>
    <button type="button" data-act="ob-close" data-css="margin:12px;text-decoration:underline">Skip for now</button>
  </aside>`;

  let body = "";
  if (step.key === "welcome") {
    body = `<p>An assistant that lives on this computer, with Trunks that each take one job. This takes about three minutes; you can change everything later.</p>
    <div data-css="padding:12px;border-radius:8px;background:var(--fill);margin:16px 0">
      <b>How Branch stays safe</b>
      <ul data-css="list-style:none;padding:0;margin:8px 0 0">
        <li data-css="padding:8px 0;display:flex;gap:8px"><span data-css="color:var(--ok);flex-shrink:0">✓</span><span>It asks before it sends, deletes, spends or installs anything.</span></li>
        <li data-css="padding:8px 0;display:flex;gap:8px"><span data-css="color:var(--ok);flex-shrink:0">✓</span><span>Your conversations and keys stay on your computers.</span></li>
        <li data-css="padding:8px 0;display:flex;gap:8px"><span data-css="color:var(--ok);flex-shrink:0">✓</span><span>You can take over, stop it, or roll back any change.</span></li>
      </ul>
    </div>
    <label data-css="display:flex;gap:8px;align-items:center;cursor:pointer">
      <input type="checkbox" id="ob-trust" data-css="width:16px;height:16px">
      <span>I understand Branch can act on this computer when I allow it</span>
    </label>`;
  } else if (step.key === "where") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Where should Branch run?</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">The engine and the gateway live here. You can talk to it from anywhere.</p>
    <div data-css="display:flex;flex-direction:column;gap:8px">
      <button class="ob-opt" type="button" data-act="ob-set" data-k="where" data-v="this" data-css="text-align:left;padding:12px;border-radius:8px;background:${ob.where === "this" ? "var(--fill-2)" : "var(--fill)"}">
        <b>This computer</b>
        <div data-css="font-size:13px;color:var(--ink-2)">Recommended. Private, free, fast.</div>
      </button>
      <button class="ob-opt" type="button" data-act="ob-set" data-k="where" data-v="remote" data-css="text-align:left;padding:12px;border-radius:8px;background:${ob.where === "remote" ? "var(--fill-2)" : "var(--fill)"}">
        <b>Another computer</b>
        <div data-css="font-size:13px;color:var(--ink-2)">Over Tailscale or SSH: a home server or a desk PC.</div>
      </button>
      <button class="ob-opt" type="button" data-act="ob-set" data-k="where" data-v="later" data-css="text-align:left;padding:12px;border-radius:8px;background:${ob.where === "later" ? "var(--fill-2)" : "var(--fill)"}">
        <b>Decide later</b>
        <div data-css="font-size:13px;color:var(--ink-2)">Start here and move it any time.</div>
      </button>
    </div>`;
  } else if (step.key === "models") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Which models should answer?</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Available on this computer</p>
    <div data-css="display:flex;flex-direction:column;gap:8px">
      <label data-css="display:flex;gap:8px;padding:8px">
        <input type="checkbox" data-sw="ob-brain" data-i="0" checked>
        <span>OpenAI GPT-6 Sol</span>
      </label>
      <label data-css="display:flex;gap:8px;padding:8px">
        <input type="checkbox" data-sw="ob-brain" data-i="1" checked>
        <span>Claude Opus 5.5</span>
      </label>
    </div>`;
  } else if (step.key === "look") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Make it yours</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Two quick choices. Both can change any time in Settings.</p>`;
  } else if (step.key === "trunks") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Your first Trunks</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Pick a few, or tell Branch about your life and work.</p>`;
  } else if (step.key === "reach") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Reach Branch anywhere</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Message a Trunk from Telegram, WhatsApp, Discord, Slack.</p>`;
  } else if (step.key === "tools") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Tools to start with</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Recommended for the Trunks you picked.</p>`;
  } else if (step.key === "gateway") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Keep it running</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Enables Telegram, phone and automations when Branch is closed.</p>`;
  } else if (step.key === "people") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Anyone else?</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">People on this computer, teammates on theirs, or your team.</p>`;
  } else if (step.key === "more") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">Two more things</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Both optional. Skip them and Branch works the same.</p>`;
  } else if (step.key === "check") {
    body = `<p data-css="margin-bottom:16px;font-weight:600">All set?</p>
    <p data-css="color:var(--ink-2);margin-bottom:16px">Branch checks everything before you start.</p>
    <ol data-css="list-style:none;padding:0;margin:0">
      ${["The engine", "Models", "The gateway", "Telegram", "Bitwarden", "Disk space"]
        .map((item, i) => `<li data-css="padding:8px 0;display:flex;gap:8px;align-items:center">
          ${i < ob.checked ? '<span data-css="color:var(--ok);font-size:16px">✓</span>' : '<span data-css="width:16px;height:16px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;display:inline-block"></span>'}
          <span>${esc(item)}</span>
        </li>`).join("")}
    </ol>`;
  }

  const footer = step.key === "welcome"
    ? ""
    : step.key === "check"
    ? `<button class="btn pri" data-act="ob-done" ${ob.checked >= 6 ? "" : 'aria-disabled="true"'}>Open Branch and take the walkthrough</button>`
    : `<button class="btn pri" data-act="ob-next">Continue</button>`;

  const html = `<div class="ob9" role="dialog" aria-modal="true" data-css="display:grid;grid-template-columns:240px 1fr;height:100%;position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;background:var(--bg)">
    ${rail}
    <main class="ob-main" data-css="display:flex;flex-direction:column;padding:24px">
      <div class="ob-body" data-css="flex:1;overflow-y:auto">
        ${body}
      </div>
      <div class="ob-foot" data-css="display:flex;gap:12px;margin-top:24px">
        <button class="btn ghost" data-act="ob-close">Back</button>
        <div data-css="flex:1"></div>
        ${footer}
      </div>
    </main>
  </div>`;

  const root = document.createElement("div");
  root.innerHTML = html;
  applyCss(root);
  greyOut(root);

  const existing = document.querySelector(".ob9");
  if (existing) existing.remove();
  document.getElementById("app").appendChild(root.firstElementChild);

  const checkbox = document.getElementById("ob-trust");
  if (checkbox) {
    checkbox.checked = ob.trust;
    checkbox.addEventListener("change", () => {
      ob.trust = checkbox.checked;
      drawSetup();
    });
  }

  if (step.key === "check" && ob.checked < 6) {
    setTimeout(() => { if (S.ob) { S.ob.checked++; drawSetup(); } }, 380);
  }
}

function closeSetup() {
  S.ob = null;
  localStorage.setItem("branch-setup-seen", "true");
  render();
}

async function finishSetup() {
  try {
    await api("onboarding", { done: true }, "POST");
    S.ob = null;
    localStorage.setItem("branch-setup-seen", "true");
    render();
    toast("Branch is ready. Let's take the walkthrough.");
    setTimeout(() => { run("tour"); }, 700);
  } catch (e) {
    toast("Failed to save setup: " + (e.message || "Unknown error"));
  }
}
