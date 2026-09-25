/* Settings › appearance: bind real engine data and wire controls. */
import { level, S, E, refresh } from "../../core/state.js";
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";

/* The light and dark previews mirror the conversation that is open (its title and last line). */
const current = () => E.sessions.find((s) => s.sessionId === S.chat) ?? E.sessions[0];
const mirrorName = () => current()?.opening || E.state?.identity?.name || "";
const mirrorLine = () => (current()?.lastMessage ?? "").slice(0, 90);

let prefs = {
  textSize: "medium",
  conversationWidth: "wide",
};

let delight = {
  background: { on: false, scrim: 60 },
  pets: { on: false, kind: "squirrel", name: "Hazel" },
};

async function loadSettings() {
  try {
    // The engine answers preferences inside its state (POST /api/preferences saves them); there is no GET of its own.
    const [st, d] = await Promise.all([api("state"), api("delight")]);
    prefs = st?.preferences || prefs;
    delight = d || delight;
  } catch (err) {
    console.error("Failed to load appearance settings:", err);
  }
  render();
}

async function savePreferences(updates) {
  try {
    const merged = { ...prefs, ...updates };
    await api("preferences", merged);
    prefs = merged;
    refresh();
    render();
  } catch (err) {
    toast(err.message || "Failed to save preferences");
    render();
  }
}

async function saveDelight(updates) {
  try {
    const merged = { ...delight, ...updates };
    await api("delight/settings", merged);
    delight = merged;
    render();
  } catch (err) {
    toast(err.message || "Failed to save delight settings");
    render();
  }
}

export function draw() {
  return `<h1>Appearance</h1><p class="lede">How Branch looks on this computer. Changes show as you pick.</p>
  <div class="sec"><h2>Light or dark</h2><div class="mirrors"><button class="mirror" type="button" data-act="themeset" data-v="light" aria-pressed="false"><span class="mm" data-css="background:#F8FAFB"><span class="mm-s" data-css="background:#EFF3F5"><span class="mm-r"><i data-css="background:#2F8C86"></i><u data-css="background:#7A8791;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#D8612A"></i><u data-css="background:#7A8791;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#8A5AA8"></i><u data-css="background:#7A8791;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#5E8C4A"></i><u data-css="background:#7A8791;opacity:.5"></u></span></span><span class="mm-m"><span><span class="mm-b" data-css="background:#E6ECEF;color:#16212A;display:block"></span><span class="mm-t" data-css="color:#16212A;display:block">${esc(mirrorLine())}</span></span><span class="mm-c" data-css="border:1px solid #C9D3D9"><i data-css="background:#E07033"></i></span></span></span><b>Light · live mirror of ${esc(mirrorName())}</b></button><button class="mirror" type="button" data-act="themeset" data-v="dark" aria-pressed="false"><span class="mm" data-css="background:#11161A"><span class="mm-s" data-css="background:#0C1013"><span class="mm-r"><i data-css="background:#2F8C86"></i><u data-css="background:#7D8A93;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#D8612A"></i><u data-css="background:#7D8A93;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#8A5AA8"></i><u data-css="background:#7D8A93;opacity:.5"></u></span><span class="mm-r"><i data-css="background:#5E8C4A"></i><u data-css="background:#7D8A93;opacity:.5"></u></span></span><span class="mm-m"><span><span class="mm-b" data-css="background:#1A2228;color:#E8EEF2;display:block"></span><span class="mm-t" data-css="color:#E8EEF2;display:block">${esc(mirrorLine())}</span></span><span class="mm-c" data-css="border:1px solid #2D3840"><i data-css="background:#E07033"></i></span></span></span><b>Dark · live mirror of ${esc(mirrorName())}</b></button><button class="mirror" type="button" data-act="themeset" data-v="system" aria-pressed="true"><span class="mm" data-css="grid-template-columns:1fr 1fr"><span data-css="background:#F8FAFB"></span><span data-css="background:#11161A"></span></span><b>Match this computer</b></button></div></div>
  <div class="sec"><h2>Theme</h2><div class="theme-now"><span class="sw6" data-css="--a:#EFF3F5;--b:#F8FAFB;--c:#FFFFFF;--d:#16212A;--e:#D8612A;--f:#16212A;--g:#DEE5E9"><i class="s1"></i><i class="s2"><em></em><em></em><u></u><b></b></i></span><span class="grow"><b>Branch Slate</b><small>Branch · Daylight</small><span class="acts"><button class="btn pri sm" type="button" data-act="skins">Browse all 46 themes</button><button class="btn sm" type="button" data-act="ce-new"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"></path><circle cx="7.5" cy="11" r="1.1"></circle><circle cx="10.5" cy="7" r="1.1"></circle><circle cx="15" cy="7.5" r="1.1"></circle></svg>Make your own</button></span></span></div>
    <div class="ctl"><b>Accent colour</b><span class="right accs"><button type="button" class="acc theme-acc" data-act="acc-set" data-v="theme" aria-pressed="true" aria-label="The theme's own accent">A</button><button type="button" class="acc" data-css="--c:#D8612A" data-act="acc-set" data-v="#D8612A" aria-pressed="false" aria-label="Accent #D8612A"></button><button type="button" class="acc" data-css="--c:#E0A526" data-act="acc-set" data-v="#E0A526" aria-pressed="false" aria-label="Accent #E0A526"></button><button type="button" class="acc" data-css="--c:#2F8F5B" data-act="acc-set" data-v="#2F8F5B" aria-pressed="false" aria-label="Accent #2F8F5B"></button><button type="button" class="acc" data-css="--c:#2F8C86" data-act="acc-set" data-v="#2F8C86" aria-pressed="false" aria-label="Accent #2F8C86"></button><button type="button" class="acc" data-css="--c:#4F6FA8" data-act="acc-set" data-v="#4F6FA8" aria-pressed="false" aria-label="Accent #4F6FA8"></button><button type="button" class="acc" data-css="--c:#8A5AA8" data-act="acc-set" data-v="#8A5AA8" aria-pressed="false" aria-label="Accent #8A5AA8"></button><button type="button" class="acc" data-css="--c:#C0467A" data-act="acc-set" data-v="#C0467A" aria-pressed="false" aria-label="Accent #C0467A"></button><button type="button" class="acc" data-css="--c:#16212A" data-act="acc-set" data-v="#16212A" aria-pressed="false" aria-label="Accent #16212A"></button><label class="acc acc-pick" aria-label="Any colour"><input type="color" id="acc-pick" value="#D8612A"></label></span><small>Only for what wants you: the working ring, the waiting dot, the yes button. <button class="link" type="button" data-act="acc-save">Save as a theme</button></small></div>
    <div class="ctl"><b>More contrast</b><input class="sw" type="checkbox" id="a-contrast" aria-label="More contrast"><small>Stronger lines and text, from each theme's own high-contrast colours.</small></div>
    </div>
  <div class="sec"><h2>Agents</h2><div class="ctl"><b>Show the agent beside the conversation</b><input class="sw" type="checkbox" id="ag-show" checked="" aria-label="Show the agent beside the conversation" data-sw="set"><small>It acts out what the Trunk is doing: thinking, searching, reading, working, waiting for you, celebrating, resting.</small></div><div class="ctl"><b>Size</b><span class="right"><span class="seg" role="group" aria-label="Size"><button type="button" aria-pressed="false" data-act="ag-size" data-v="s">Small</button><button type="button" aria-pressed="true" data-act="ag-size" data-v="m">Medium</button><button type="button" aria-pressed="false" data-act="ag-size" data-v="l">Large</button></span></span><small>Small keeps it out of the way.</small></div></div><div class="sec"><h2>Background</h2><div class="ctl" data-d12="1"><b>Behind the glass</b><span class="right"><span class="seg" role="group" aria-label="Behind the glass"><button type="button" aria-pressed="${delight.background?.on ? 'false' : 'true'}" data-act="bgset" data-v="none">None</button><button type="button" aria-pressed="false" data-act="bgset" data-v="painted">Painted grove</button><button type="button" aria-pressed="false" data-act="bgset" data-v="grove">The grove</button><button type="button" aria-pressed="false" data-act="bgset" data-v="oak3d">The oak in 3D</button><button type="button" aria-pressed="false" data-act="bgset" data-v="rings">Growth rings</button><button type="button" aria-pressed="false" data-act="bgset" data-v="own">Your own</button></span></span><small>The grove and the oak wear the theme's colours. A scrim in the theme's own colour keeps text readable.</small></div><div class="fld"><span>Painted scenes</span><div class="scenes12"><button type="button" class="scene-c12" data-act="scene-set" data-v="auto" aria-pressed="false"><span class="sc-img12 sc-auto12"><i data-css="background-image:url('/art/grove-spring.webp')"></i><i data-css="background-image:url('/art/grove-autumn.webp')"></i><i data-css="background-image:url('/art/grove-winter.webp')"></i><i data-css="background-image:url('/art/grove-night.webp')"></i></span><b>By the season</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="spring" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/grove-spring.webp')"></span><b>Spring grove</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="autumn" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/grove-autumn.webp')"></span><b>Autumn grove</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="winter" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/grove-winter.webp')"></span><b>Winter grove</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="night" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/grove-night.webp')"></span><b>Firefly night</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="summer" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-summer.webp')"></span><b>Summer Meadow</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="rain" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-rain.webp')"></span><b>Rainy Forest</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="lake" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-lake.webp')"></span><b>Mountain Lake</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="blossom" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-blossom.webp')"></span><b>Blossoming Grove</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="canyon" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-canyon.webp')"></span><b>Desert Canyon</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="snownight" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-snownight.webp')"></span><b>Snowy Night</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="bamboo" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-bamboo.webp')"></span><b>Bamboo Grove</b></button><button type="button" class="scene-c12" data-act="scene-set" data-v="hills" aria-pressed="false"><span class="sc-img12" data-css="background-image:url('/art/bg/grove-hills.webp')"></span><b>Sunflower Hills</b></button></div></div>
    <div class="ctl"><b>How much the theme covers it</b><span class="right"><input class="range" type="range" id="scrim6" min="20" max="90" step="5" value="${delight.background?.scrim || 60}" aria-label="How much the theme covers the background" disabled=""><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${delight.background?.scrim || 60}%</span></span><small>More keeps text calmer; less shows more of the background.</small></div>
    <div class="ctl"><b>See-through panels</b><span class="right"><input class="range" type="range" id="see" min="0" max="60" step="5" value="25" aria-label="See-through panels" disabled=""><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">25%</span></span><small>Panels blur what's behind them.</small></div>
    <div class="ctl"><b>Preview</b><span class="right"><button class="btn sm" type="button" data-act="bg-peek" disabled=""><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>See it clearly</button></span><small>Clear the view: see the background. Click anywhere or press Escape to come back.</small></div></div>
  <div class="sec"><h2>Reading</h2><div class="ctl"><b>Conversation width</b><span class="right"><span class="seg" role="group" aria-label="Conversation width"><button type="button" aria-pressed="${prefs.conversationWidth === 'comfortable' ? 'true' : 'false'}" data-act="widthset" data-v="comfortable">Comfortable</button><button type="button" aria-pressed="${prefs.conversationWidth === 'wide' ? 'true' : 'false'}" data-act="widthset" data-v="wide">Wide</button><button type="button" aria-pressed="${prefs.conversationWidth === 'full' ? 'true' : 'false'}" data-act="widthset" data-v="full">Full</button></span></span><small>Wide uses more of a big screen.</small></div><div class="ctl"><b>Text size</b><span class="right"><span class="seg" role="group" aria-label="Text size"><button type="button" aria-pressed="${prefs.textSize === 'small' ? 'true' : 'false'}" data-act="size" data-v="small">Small</button><button type="button" aria-pressed="${prefs.textSize === 'medium' ? 'true' : 'false'}" data-act="size" data-v="medium">Regular</button><button type="button" aria-pressed="${prefs.textSize === 'large' ? 'true' : 'false'}" data-act="size" data-v="large">Large</button></span></span><small>Changes every screen.</small></div></div>
  <div class="sec"><h2>The pet</h2><div class="ctl" data-d12="1"><b>Pet</b><span class="right"><span class="seg" role="group" aria-label="Pet"><button type="button" aria-pressed="${!delight.pets?.on ? 'true' : 'false'}" data-act="petset" data-v="none">None</button><button type="button" aria-pressed="${delight.pets?.kind === 'squirrel' ? 'true' : 'false'}" data-act="petset" data-v="squirrel">Squirrel</button><button type="button" aria-pressed="${delight.pets?.kind === 'owl' ? 'true' : 'false'}" data-act="petset" data-v="owl">Owl</button><button type="button" aria-pressed="${delight.pets?.kind === 'hedgehog' ? 'true' : 'false'}" data-act="petset" data-v="hedgehog">Hedgehog</button></span></span><small>It walks along the foot of the list. Click it for a tip; it speaks up by itself only when a Trunk needs you.</small></div></div>
  <div class="sec"><h2>What's shown</h2><div class="ctl"><b>The usage ring</b><input class="sw" type="checkbox" id="h-usage" checked="" aria-label="The usage ring" data-sw="hide" data-k="usage"><small>Right-click it anywhere to hide it too.</small></div><div class="ctl"><b>The gateway in the status bar</b><input class="sw" type="checkbox" id="h-gateway" checked="" aria-label="The gateway in the status bar" data-sw="hide" data-k="gateway"><small>Right-click it anywhere to hide it too.</small></div><div class="ctl"><b>The pet</b><input class="sw" type="checkbox" id="h-pet" checked="" aria-label="The pet" data-sw="hide" data-k="pet"><small>Right-click it anywhere to hide it too.</small></div><div class="ctl"><b>Projects in the list</b><input class="sw" type="checkbox" id="h-projects" checked="" aria-label="Projects in the list" data-sw="hide" data-k="projects"><small>Right-click it anywhere to hide it too.</small></div><div class="ctl"><b>The Guide button</b><input class="sw" type="checkbox" id="h-notes" checked="" aria-label="The Guide button" data-sw="hide" data-k="notes"><small>Right-click it anywhere to hide it too.</small></div><div class="ctl"><b>The whole status bar</b><input class="sw" type="checkbox" id="h-statusbar" checked="" aria-label="The whole status bar" data-sw="hide" data-k="statusbar"><small>Lockdown's banner and Stop while a task runs can never be hidden.</small></div>
    <div class="ctl"><b>Keep things still</b><input class="sw" type="checkbox" id="a-still" aria-label="Keep things still" data-sw="still"><small>Stops the pet walking, the working ring, the logo's float and the background moving.</small></div>
    <div class="ctl"><b>Scenery behind the list</b><input class="sw" type="checkbox" id="a-scenery" aria-label="Scenery behind the list" data-sw="scenery"><small>A small pixel oak at the foot of the list.</small></div></div>
  <div class="sec"><h2>Language</h2><div class="ctl"><b>Language</b><span class="right"><select class="inp" id="lang" data-sw="lang" aria-label="Language"><option>English</option><option>Français</option><option>Español</option><option>Deutsch</option><option>Yorùbá</option></select></span><small>Dates and numbers follow it too.</small></div></div>`;
}

export function init() {
  loadSettings();

  // "themeset" belongs to the shell, which applies the look and saves it to the engine.

  on("widthset", (el) => {
    const value = el.dataset.v;
    savePreferences({ conversationWidth: value });
  });

  on("size", (el) => {
    const value = el.dataset.v;
    savePreferences({ textSize: value });
  });

  on("bgset", (el) => {
    const value = el.dataset.v;
    const on = value !== "none";
    saveDelight({ background: { ...delight.background, on } });
  });

  on("petset", (el) => {
    const value = el.dataset.v;
    if (value === "none") {
      saveDelight({ pets: { ...delight.pets, on: false } });
    } else {
      saveDelight({ pets: { ...delight.pets, on: true, kind: value } });
    }
  });

  markLive([
    "themeset",
    "widthset",
    "size",
    "bgset",
    "petset",
  ]);
}

export async function load() {
  await loadSettings();
}

export const live = {
  "themeset": true,
  "widthset": true,
  "size": true,
  "bgset": true,
  "petset": true,
};
