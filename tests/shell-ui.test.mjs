import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openPlace, openSettingFor, showEverything } from "./places.mjs";

/* Wave 9 redesign: four places in the sidebar, and Settings behind the gear (public/layout.js). */
const PLACES = ["Inbox", "Automations", "Library", "Customize"];

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-shell-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  /* These tests are about the full shell: every rail row, icon, tab and meter. Since 0.18.1 that is
     "Show everything"; the calm default has its own tests in calm-ui.test.mjs. */
  await showEverything(page);
  return { page, server, errors };
}
const look = (page) => page.evaluate(() => ({ ...document.documentElement.dataset }));
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 },
  { width: 400, height: 800 },
];
/** True when two boxes share any pixel. */
const boxesHit = (page, one, two) =>
  page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a).getBoundingClientRect();
      const second = document.querySelector(b).getBoundingClientRect();
      return !(first.bottom <= second.top || second.bottom <= first.top);
    },
    [one, two],
  );
/** Walks Tab and reports where the focus landed each time. */
async function tabStops(page, count) {
  const stops = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  }
  return stops;
}

test("every place opens from the sidebar in one click, and every Settings page from the gear", async (t) => {
  const f = await fixture(t);
  // The places are buttons in the sidebar, never a drop-down. Integration review (mac7/wake-pins):
  // this looks outside the Settings window, because a drop-down inside Settings is not navigation.
  // mac7/linux-fixes: it also used to look for the word "Memory", which is not one of the places at
  // all, so it went off on any drop-down with a memory-ish option — on Linux it caught
  // #knobs-memoryProvider, the Memory card's own provider picker, once that card had drawn. A
  // drop-down of places would list the places, so it is their own names that are looked for now.
  const placesInADropDown = () => f.page.locator("select:not(#settings-window select)")
    .filter({ hasText: PLACES[0] }).filter({ hasText: PLACES[1] }).count();
  assert.equal(await placesInADropDown(), 0, "places must not live in a drop-down");
  // And the check above can still go off: a drop-down of places in the shell is caught, so scoping
  // it away from the Settings window did not quietly turn it into an assertion that cannot fail.
  await f.page.evaluate((places) => {
    const select = document.createElement("select");
    select.id = "places-drop-down-probe";
    for (const place of places) select.append(new Option(place, place.toLowerCase()));
    document.getElementById("workspace").append(select);
  }, PLACES);
  assert.equal(await placesInADropDown(), 1, "this check can no longer catch places moving into a drop-down");
  await f.page.evaluate(() => document.getElementById("places-drop-down-probe").remove());
  assert.equal(await placesInADropDown(), 0);
  for (const name of PLACES) {
    await f.page.getByRole("button", { name, exact: true }).click();
    await f.page.locator("#page-title").filter({ hasText: name }).waitFor();
  }
  await f.page.getByRole("button", { name: "Conversation", exact: true }).click();
  await f.page.locator("#page-title").filter({ hasText: "Conversation" }).waitFor();
  await f.page.getByRole("button", { name: "Settings", exact: true }).click();
  await f.page.locator("#settings-window").waitFor({ state: "visible" });
  const pages = f.page.locator(".lx-settings-link");
  assert.equal(await pages.count(), 20, "Settings includes every first-class page and honest place directory");
  for (let index = 0; index < await pages.count(); index += 1) {
    await pages.nth(index).click();
    assert.equal(await pages.nth(index).getAttribute("aria-current"), "true");
    assert.equal(await f.page.locator(".lx-page:not([hidden])").count(), 1, "one page at a time");
  }
  await f.page.keyboard.press("Escape");
  await f.page.locator("#settings-window").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("the rail switches between conversations and real Trunks without duplicating either", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  assert.equal(await f.page.locator("#rail-view-conversations").getAttribute("aria-selected"), "true");
  assert.equal(await f.page.locator('.rail-group[data-group="recents"]').isVisible(), true);
  assert.equal(await f.page.locator("#rail-new-trunk").isVisible(), false);
  assert.equal(await f.page.locator("#rail-target-name").textContent(), "This computer");
  await f.page.locator("#branch-tree").evaluate((node) => { node.hidden = false; node.textContent = "A branch"; });
  assert.equal(await f.page.locator("#branch-tree").isVisible(), true);
  await f.page.locator("#rail-view-trunks").click();
  assert.equal(await f.page.locator("#rail-view-trunks").getAttribute("aria-selected"), "true");
  assert.equal(await f.page.locator('.rail-group[data-group="recents"]').isVisible(), false);
  assert.equal(await f.page.locator("#rail-new-trunk").isVisible(), true);
  assert.equal(await f.page.locator("#branch-tree").isVisible(), false, "conversation branches do not mix into Trunks");
  await f.page.locator("#branch-tree").evaluate((node) => { node.hidden = false; });
  assert.equal(await f.page.locator("#branch-tree").isVisible(), false, "a redraw cannot override the chosen rail view");
  assert.equal(await f.page.evaluate(() => localStorage.getItem("branch-rail-view")), "trunks");
  await f.page.locator("#rail-new-trunk").click();
  await f.page.locator("#studio").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#studio").getByText("Trunks are switched off.").isVisible(), true);
  await f.page.locator("#studio").getByRole("button", { name: "Switch Trunks on" }).click();
  await f.page.locator("#trunks-rail").waitFor({ state: "visible" });
  await f.page.locator("#studio-name").fill("Scout");
  await f.page.locator("#studio").getByRole("button", { name: "Create the Trunk" }).click();
  await f.page.locator("#studio").waitFor({ state: "detached" });
  await f.page.locator('#trunks-rail [data-trunk]').filter({ hasText: "Scout" }).waitFor({ state: "visible" });
  await f.page.locator("#rail-view-trunks").press("ArrowLeft");
  assert.equal(await f.page.locator("#rail-view-conversations").getAttribute("aria-selected"), "true");
  assert.deepEqual(f.errors, []);
});

test("the selected Trunk stays named when its visual strip is off", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  const selected = await f.page.evaluate(async () => {
    const strip = await import("/strip.js");
    strip.shell.roster = { modes: { trunks: "on" }, trunks: [{ id: "ada", name: "Ada", chatSessionId: "ada-chat" }] };
    strip.shell.look.strip = "off";
    document.getElementById("conversation").dataset.sessionId = "ada-chat";
    strip.drawStrip();
    document.getElementById("rail-target-name").textContent = "This computer";
    const { setLanguage } = await import("/i18n.js");
    await setLanguage("fr");
    return document.getElementById("rail-target-name").textContent;
  });
  assert.equal(selected, "Ada");
  assert.equal(await f.page.locator("#trunk-strip").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("a hidden active Trunk stays named in the rail", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  const selected = await f.page.evaluate(async () => {
    const strip = await import("/strip.js");
    strip.shell.roster = { modes: { trunks: "on" }, trunks: [
      { id: "hidden-ada", name: "Ada", chatSessionId: "hidden-ada-chat", hidden: true },
    ] };
    document.getElementById("conversation").dataset.sessionId = "hidden-ada-chat";
    document.getElementById("rail-target-name").textContent = "This computer";
    strip.drawStrip();
    return { name: document.getElementById("rail-target-name").textContent,
      visible: !!document.querySelector('[data-strip-id="trunk:hidden-ada"]') };
  });
  assert.deepEqual(selected, { name: "Ada", visible: false }, "hiding the roster face does not change who owns the conversation");
  assert.deepEqual(f.errors, []);
});

test("the Trunks rail stays owner-only", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  await f.page.locator("#rail-view-trunks").click();
  const headers = { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" };
  const person = await fetch(`${f.server.url}/api/profiles`, {
    method: "POST", headers, body: JSON.stringify({ name: "Sam", pin: "2468" }),
  }).then((response) => response.json());
  assert.equal((await fetch(`${f.server.url}/api/profiles/switch`, {
    method: "POST", headers, body: JSON.stringify({ profileId: person.id, pin: "2468" }),
  })).status, 200);
  const synchronous = await f.page.evaluate(() => {
    const oldGroup = document.getElementById("trunks-rail");
    oldGroup?.remove();
    const group = document.createElement("section");
    group.id = "trunks-rail";
    group.textContent = "Private Trunk name and latest words";
    document.getElementById("rail-scroll").append(group);
    document.dispatchEvent(new CustomEvent("branch-strip", {
      detail: { profiles: { isOwner: true }, profileGeneration: 0 },
    }));
    const ownerGroupVisible = !group.hidden;
    document.dispatchEvent(new CustomEvent("branch-strip-selection", { detail: {
      name: "Private Ada", kind: "Private Trunk", status: "Working",
    } }));
    const generation = Number(document.documentElement.dataset.profileGeneration || 0) + 1;
    document.documentElement.dataset.household = "on";
    document.documentElement.dataset.profileGeneration = String(generation);
    document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: false, profileGeneration: generation } }));
    return { ownerGroupVisible, group: group.hidden,
      tab: document.getElementById("rail-view-trunks").hidden,
      conversations: document.getElementById("rail-view-conversations").getAttribute("aria-selected"),
      target: document.getElementById("rail-target-name").textContent,
      translated: document.getElementById("rail-target-name").dataset.t };
  });
  assert.deepEqual(synchronous, { ownerGroupVisible: true, group: true, tab: true, conversations: "true",
    target: "This computer", translated: "strip.here" },
  "owner-only names, actions and selected identity disappear in the profile event itself");
  /* A strip refresh that began for the owner may finish after the profile event. It must not put
     owner-only names and actions back into somebody else's window. */
  await f.page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-strip", {
    detail: { profiles: { isOwner: true },
      profileGeneration: Number(document.documentElement.dataset.profileGeneration || 0) - 1 },
  })));
  await f.page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-strip-selection", { detail: {
    name: "Stale private Ada", kind: "Private Trunk", status: "Working",
  } })));
  assert.equal(await f.page.locator("#rail-view-trunks").isVisible(), false);
  assert.equal(await f.page.locator("#rail-new-trunk").isVisible(), false);
  assert.equal(await f.page.locator("#rail-view-conversations").getAttribute("aria-selected"), "true");
  assert.equal(await f.page.locator("#rail-target-name").textContent(), "This computer",
    "a late owner-side selection cannot restore a private name");
  await f.page.locator("#rail-view-conversations").focus();
  await f.page.keyboard.press("ArrowRight");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "rail-view-conversations",
    "arrow navigation contains only visible choices");
  assert.deepEqual(f.errors, []);
});

test("an ordinary conversation assigned to a Trunk updates the shell target", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  const target = await f.page.evaluate(async () => {
    const strip = await import("/strip.js");
    strip.shell.roster = { modes: { trunks: "on" }, trunks: [
      { id: "assigned-ada", name: "Ada", handle: "ada", chatSessionId: "ada-own-chat" },
    ] };
    document.getElementById("conversation").dataset.sessionId = "ordinary-chat";
    strip.drawStrip();
    document.dispatchEvent(new CustomEvent("branch-rooms-changed", { detail: {
      kind: "trunk", trunkId: "assigned-ada",
    } }));
    return document.getElementById("rail-target-name").textContent;
  });
  assert.equal(target, "Ada");
  assert.deepEqual(f.errors, []);
});

test("the Trunks rail recovers after profile loading fails or the owner returns", async (t) => {
  const f = await fixture(t);
  await f.page.locator('#trunk-strip [data-strip-id="here"]').waitFor();
  const targets = await f.page.evaluate(() => {
    const selectAda = () => document.dispatchEvent(new CustomEvent("branch-strip-selection", { detail: {
      name: "Ada", kind: "Trunk", status: "Online",
    } }));
    document.addEventListener("branch-strip-reselect", selectAda);
    document.dispatchEvent(new CustomEvent("branch-strip", { detail: { profiles: null } }));
    document.dispatchEvent(new CustomEvent("branch-strip", { detail: { profiles: { isOwner: true } } }));
    const afterRetry = document.getElementById("rail-target-name").textContent;
    document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: false } }));
    document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: true } }));
    selectAda();
    const beforeRefresh = document.getElementById("rail-target-name").textContent;
    document.dispatchEvent(new CustomEvent("branch-strip", { detail: { profiles: { isOwner: true } } }));
    return { afterRetry, beforeRefresh, afterRefresh: document.getElementById("rail-target-name").textContent };
  });
  assert.deepEqual(targets, { afterRetry: "Ada", beforeRefresh: "This computer", afterRefresh: "Ada" });
  assert.deepEqual(f.errors, []);
});

test("a new screen that names its home with data-home is shown there, even when added later", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const card = document.createElement("section");
    card.className = "card";
    card.id = "home-probe";
    card.dataset.home = "settings:secrets";
    card.innerHTML = "<h2>Probe</h2><p>Lands on the Secrets page.</p>";
    document.getElementById("workspace").append(card);
    const local = document.createElement("section");
    local.id = "home-probe-local";
    local.dataset.home = "settings:models:local";
    document.body.append(local);
  });
  await f.page.waitForFunction(() => document.getElementById("home-probe").closest("#lx-page-secrets")
    && document.getElementById("home-probe-local").closest("#lx-models-local"));
  await openSettingFor(f.page, "#home-probe");
  await f.page.locator("#home-probe").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("the command palette jumps to a section and closes on Escape", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.locator("#cmd-input").fill("Schedu");
  await f.page.locator(".cmd-item").first().click();
  assert.match(await f.page.locator("#page-title").innerText(), /Automations/);
  assert.equal(await f.page.locator('.lx-tab[data-view="schedules"]').getAttribute("aria-selected"), "true");
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("every appearance control applies at once and survives a reload", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#appearance");
  await f.page.getByRole("button", { name: "Light", exact: true }).click();
  await f.page.getByRole("button", { name: "Cherry", exact: true }).click();
  await f.page.getByRole("button", { name: "Large", exact: true }).click();
  await f.page.getByRole("button", { name: "Compact", exact: true }).click();
  await f.page.getByRole("button", { name: "This computer's lettering", exact: true }).click();
  await f.page.locator("#appearance-motion").check();
  await f.page.locator("#appearance-acorn").uncheck();
  const chosen = {
    theme: "daylight",
    accent: "copper",
    palette: "cherry",
    textSize: "large",
    density: "compact",
    font: "system",
    motion: "reduced",
    acorn: "off",
    everything: "on",
    voice: "off",
    settingsLevel: "advanced", // phase2/settings: Show everything is the Advanced level of Settings
    convw: "wide", // phase2/panels: how wide the conversation grows (What's on screen)
  };
  assert.deepEqual(await look(f.page), chosen, "every choice shows straight away");
  assert.equal(await f.page.locator(".acorn-art").isVisible(), false);
  await f.page.getByRole("button", { name: "Save appearance", exact: true }).click();
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await f.page.waitForFunction(() => document.documentElement.dataset.textSize === "large");
  const accent = await f.page.evaluate(async () => {
    const { THEMES, TOKEN_NAMES } = await import("/theme-catalogue.js");
    const cherry = THEMES.find((theme) => theme[0] === "cherry")[3].light;
    return {
      shown: getComputedStyle(document.documentElement).getPropertyValue("--copper").trim(),
      cherry: cherry[TOKEN_NAMES.indexOf("--copper")],
    };
  });
  assert.equal(accent.shown, accent.cherry, "the chosen theme's accent is the one on the page");
  assert.deepEqual(await look(f.page), chosen, "the same look comes back after a reload");
  assert.deepEqual(f.errors, []);
});

test("an unknown appearance value is refused and the saved look is unchanged", async (t) => {
  const f = await fixture(t);
  const send = (body) =>
    fetch(new URL("/api/preferences", f.server.url), {
      method: "POST",
      headers: {
        authorization: "Bearer " + f.server.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await send({ appearance: "midnight" })).ok, false);
  assert.equal((await send({ accent: "purple" })).ok, false);
  const kept = await (await send({ appearance: "daylight" })).json();
  assert.equal(kept.accent, "copper", "fields left out keep their defaults");
  assert.equal(kept.showAcorn, false, "the acorn starts off");
  assert.equal(kept.showEverything, false, "the calm window is the default");
});

test("the shell fits a 400 pixel window without sideways scrolling", async (t) => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 400, height: 800 });
  assert.equal(
    await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  /* On a narrow window the rail slides over the page, so it is opened first. */
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  await f.page.getByRole("button", { name: "Library", exact: true }).click();
  assert.match(await f.page.locator("#page-title").innerText(), /Library/);
  assert.equal(
    await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.deepEqual(f.errors, []);
});

test("a rail folded away on a wide window still opens on a narrow one", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  assert.equal(await f.page.locator("#conversation-rail").isVisible(), false);
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await f.page.setViewportSize({ width: 400, height: 800 });
  assert.equal(await f.page.locator("#conversation-rail").isVisible(), false);
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  await f.page.locator("#conversation-rail").waitFor({ state: "visible" });
  await f.page.getByRole("button", { name: "Find anything Ctrl K" }).click();
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("this computer's reduce-motion setting is honoured before anyone opens Appearance", async (t) => {
  const f = await fixture(t);
  const speed = () =>
    f.page
      .locator("#update-bar")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).transitionDuration));
  assert.equal(
    await f.page.evaluate(() => "motion" in document.documentElement.dataset),
    false,
    "nothing is written until the owner asks for stillness",
  );
  assert.equal(await speed(), 0.3, "normally things move");
  await f.page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await speed()) < 0.01, true, "this computer's setting switches it off");
  await f.page.emulateMedia({ reducedMotion: "no-preference" });
  await f.page.locator("#appearance-shortcut").click();
  await f.page.locator("#appearance-motion").check();
  assert.equal((await speed()) < 0.01, true, "so does the Appearance choice");
  assert.deepEqual(f.errors, []);
});

test("the composer never comes to rest on top of the greeting or the welcome card", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.locator("#first-run").isVisible(), true, "a new workspace starts on the welcome card");
  for (const size of SIZES) {
    await f.page.setViewportSize(size);
    /* The variable is written when the dock reports its new size, which a loaded machine can take
       well over a fixed pause to do; wait for the two to agree, and the assertion below still
       names the size if they never do. */
    await f.page
      .waitForFunction(() =>
        Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--composer-h"), 10) ===
          Math.round(document.getElementById("composer-dock").getBoundingClientRect().height), undefined, { timeout: 10000 })
      .catch(() => undefined);
    /* The column keeps exactly the composer's height in reserve at its end. */
    const reserved = await f.page.evaluate(() => ({
      variable: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--composer-h"), 10),
      dock: Math.round(document.getElementById("composer-dock").getBoundingClientRect().height),
      padding: Number.parseInt(getComputedStyle(document.getElementById("chat")).paddingBottom, 10),
    }));
    assert.equal(reserved.variable, reserved.dock, `--composer-h follows the dock at ${size.width}`);
    assert.equal(reserved.padding >= reserved.dock, true, `the column reserves the dock's height at ${size.width}`);
    await f.page.evaluate(() => {
      const column = document.getElementById("workspace");
      column.scrollTo(0, column.scrollHeight);
    });
    await f.page.waitForTimeout(150);
    assert.equal(
      await boxesHit(f.page, "#first-run", "#composer-dock"),
      false,
      `the welcome card clears the composer at ${size.width}×${size.height}`,
    );
  }
  /* And once the welcome card is done, the greeting takes its place, still clear. */
  await f.page.evaluate(async () => {
    await fetch("/api/onboarding", {
      method: "POST",
      headers: {
        authorization: "Bearer " + sessionStorage.getItem("branch-token"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ done: true }),
    });
  });
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  for (const size of SIZES) {
    await f.page.setViewportSize(size);
    await f.page.waitForTimeout(150);
    await f.page.locator("#greeting").waitFor({ state: "visible" });
    assert.equal(
      await boxesHit(f.page, "#greeting", "#composer-dock"),
      false,
      `the greeting clears the composer at ${size.width}×${size.height}`,
    );
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `no sideways scrolling at ${size.width}`,
    );
  }
  assert.deepEqual(f.errors, []);
});

test("Send keeps its label on one line and the helper note sits under the composer", async (t) => {
  const f = await fixture(t);
  for (const size of SIZES) {
    await f.page.setViewportSize(size);
    await f.page.waitForTimeout(150);
    const send = await f.page.evaluate(() => {
      const button = document.getElementById("send");
      const range = document.createRange();
      /* Since 0.18.1 the words sit in their own span beside the calm window's arrow. */
      range.selectNodeContents(button.querySelector(".lx-send-words") ?? button);
      return { lines: range.getClientRects().length, wrap: getComputedStyle(button).whiteSpace };
    });
    assert.equal(send.lines, 1, `Send is one line at ${size.width}`);
    assert.equal(send.wrap, "nowrap");
  }
  await f.page.setViewportSize(SIZES[0]);
  const placed = await f.page.evaluate(() => {
    const note = document.getElementById("session-label");
    return {
      inComposer: Boolean(note.closest("#chat-form")),
      belowBox:
        note.getBoundingClientRect().top >= document.querySelector(".composer").getBoundingClientRect().bottom,
    };
  });
  assert.equal(placed.inComposer, false, "the helper line left the button row");
  assert.equal(placed.belowBox, true, "and sits under the composer box");
  assert.deepEqual(f.errors, []);
});

test("a Recents row lights up under the pointer in Daylight", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#appearance-shortcut").click();
  await f.page.getByRole("button", { name: "Light", exact: true }).click();
  await f.page.locator(".lx-settings-close").click();
  await f.page.locator("#prompt").fill("Say hello");
  await f.page.getByRole("button", { name: "Send", exact: true }).click();
  await f.page.locator("#conversation .message.assistant").first().waitFor({ timeout: 30000 });
  /* The rail fills itself when the workspace opens, so it is read after a reload. */
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await f.page.locator("#rail-list .rail-line").first().waitFor({ timeout: 30000 });
  const row = f.page.locator("#rail-list .rail-line").first();
  const colour = () => row.evaluate((node) => getComputedStyle(node).backgroundColor);
  const resting = await colour();
  /* The wash arrives through a CSS transition, so wait for the colour rather than for a stopwatch:
     a build machine under load paints later than a quiet laptop, and 150ms is a guess either way.
     Waited for inside the page, in one step: the old loop asked the page again every 25ms, and on a
     loaded machine each of those round trips costs more than the transition it was waiting for, so
     the deadline ran out while the wash was already on screen (seen once at load average 22). */
  /* The rail can be drawn again just after it first fills (it reloads each time the workspace is
     shown), and the browser does not move :hover onto a row that replaced the one under a still
     pointer. So the row being pointed at is marked, and if it is replaced the new row is pointed at:
     what is waited for is the wash on the row the pointer is really over. */
  let hovered = resting;
  for (let attempt = 0; attempt < 5 && hovered === resting; attempt++) {
    await row.evaluate((node) => { node.dataset.pointed = "yes"; });
    await row.hover();
    hovered = await f.page.waitForFunction((was) => {
      const node = document.querySelector("#rail-list .rail-line");
      if (!node) return null;
      if (node.dataset.pointed !== "yes") return "replaced";
      const now = getComputedStyle(node).backgroundColor;
      return now !== was ? now : null;
    }, resting, { timeout: 5000 }).then((handle) => handle.jsonValue(), () => resting);
    if (hovered === "replaced") { hovered = resting; await f.page.mouse.move(0, 0); }
  }
  assert.notEqual(hovered, resting, "the row takes a background under the pointer");
  /* color-mix serialises as color(srgb r g b / a), so the alpha is the last part. */
  const alpha = hovered.includes("/")
    ? Number.parseFloat(hovered.split("/").pop().replace(")", "").trim())
    : Number.parseFloat(hovered.replace(")", "").split(",").pop());
  assert.equal(alpha >= 0.09, true, `the wash is strong enough to see (${hovered})`);
  assert.deepEqual(f.errors, []);
});

test("Ctrl+Shift+K opens the side panel and folds it away again", async (t) => {
  const f = await fixture(t);
  const open = () => f.page.locator("#context-panel").isVisible();
  /* DG-114: the side panel is a card, closed until asked for. */
  assert.equal(await open(), false, "closed until asked for");
  await f.page.keyboard.press("Control+Shift+K");
  await f.page.waitForTimeout(150);
  assert.equal(await open(), true, "the keys open it");
  await f.page.keyboard.press("Control+Shift+K");
  await f.page.waitForTimeout(150);
  assert.equal(await open(), false, "and fold it away");
  assert.equal(await f.page.locator("#cmd-input").count(), 0, "the palette stays shut");
  assert.deepEqual(f.errors, []);
});

test("Tab walks the rail first, then the title bar, the messages and the composer", async (t) => {
  const f = await fixture(t);
  /* A reload puts the focus back at the top of the document before the walk. */
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  assert.deepEqual(await tabStops(f.page, 5), [
    "app-switcher",
    "cmd-open",
    "appearance-shortcut",
    "rail-new",
    "rail-find",
  ]);
  const walk = await tabStops(f.page, 60);
  const at = (id) => walk.indexOf(id);
  assert.equal(at("rail-toggle") > -1, true, "the title bar is reachable");
  /* phase2/settings: the Settings cog sits right after the account row, at the foot of the rail. */
  assert.equal(at("rail-settings"), at("owner-menu-button") + 1, "the cog comes right after the account row");
  assert.equal(at("conversation") > -1, true, "the messages are a stop of their own");
  assert.equal(at("rail-toggle") < at("conversation"), true, "title bar before the messages");
  assert.equal(at("conversation") < at("prompt"), true, "messages before the composer");
  assert.deepEqual(f.errors, []);
});

test("Escape leaves the message box without throwing away what was typed", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#prompt").fill("half a thought");
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "");
  assert.equal(await f.page.locator("#prompt").inputValue(), "half a thought");
  assert.deepEqual(f.errors, []);
});

test("a folded Projects group stays folded, remembered for this workspace", async (t) => {
  const f = await fixture(t);
  const head = f.page.locator('.group-head[data-toggle="projects"]');
  await head.click();
  assert.equal(await head.getAttribute("aria-expanded"), "false");
  assert.equal(await f.page.locator("#rail-projects").isVisible(), false);
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await head.getAttribute("aria-expanded"), "false", "it is still folded after a reload");
  const keys = await f.page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("branch-group-") && localStorage.getItem(key) === "closed"),
  );
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^branch-group-projects::.+/, "the choice is kept under this workspace's own name");
  /* A choice made before the workspace answered is still honoured. */
  await f.page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("branch-group-recents", "closed");
  });
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(
    await f.page.locator('.group-head[data-toggle="recents"]').getAttribute("aria-expanded"),
    "false",
  );
  assert.deepEqual(f.errors, []);
});

test("with nothing connected the context pane offers one thing to do", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.locator("#context-panel").getAttribute("data-connected"), "false");
  await f.page.locator("#aside-toggle").click(); // DG-114: the side panel is a card, closed until asked for
  await f.page.locator("#context-connect").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#context-change-model").isVisible(), false);
  await f.page.locator("#context-connect").click();
  await f.page.locator("#settings-window").waitFor({ state: "visible" });
  assert.equal(await f.page.locator('.lx-settings-link[data-page="models"]').getAttribute("aria-current"), "true");
  assert.deepEqual(f.errors, []);
});

/* ==================== Wave 8: the design QA pass ====================
   Q3 nothing is wider than a 400 px window; Q4 the words on the screens are the words in the
   glossary; Q5 focus can be seen, Escape closes what it opened, and stillness is honoured. */

/** Every screen the owner can open, as [how it is opened, the element that holds it]. */
const SETTINGS_PAGES = ["general", "assistant", "instructions", "appearance", "notifications", "models", "accounts", "voice", "permissions",
  "computer", "secrets", "data", "advanced", "about", "trunks", "channels", "connections", "skills", "memory", "automations"];
const SCREENS = [
  ["chat", "chat"], ["runs", "runs"], ["memory", "memory"], ["skills", "skills"], ["specialists", "specialists"],
  ["procedures", "procedures"], ["schedules", "schedules"], ["documents", "documents"],
  ["inbox:needs", "lx-slot-inbox-needs"], ["inbox:finished", "lx-slot-inbox-finished"],
  ["automations:triggers", "lx-slot-automations-triggers"], ["library:made", "lx-slot-library-made"],
  ["customize:plugins", "lx-slot-customize-plugins"], ["customize:connections", "lx-slot-customize-connections"],
  ["customize:channels", "lx-slot-customize-channels"],
  ...SETTINGS_PAGES.map((page) => [`settings:${page}`, `lx-page-${page}`]),
];

/** Opens a screen, letting the rail slide over first on a narrow window. */
async function openScreen(page, view) {
  await openPlace(page, view);
  await page.evaluate(() => document.body.classList.remove("rail-open"));
  await page.waitForTimeout(350);
}

test("Q3 at 400 px nothing on any screen is wider than the window", async (t) => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 400, height: 800 });
  for (const [view, holder] of SCREENS) {
    await openScreen(f.page, view);
    const tooWide = await f.page.evaluate((id) => {
      /* Only a scroller INSIDE the reading column excuses a wide box. The column itself
         (#workspace) scrolls up and down, which makes the browser report its sideways
         overflow as "auto" too; walking past it would excuse every element on the page. */
      const scrolls = (node) => {
        for (let p = node; p && p.id !== "workspace" && !p.classList.contains("lx-settings-body"); p = p.parentElement) {
          const x = getComputedStyle(p).overflowX;
          if (x === "auto" || x === "scroll") return true;
        }
        return false;
      };
      const out = [];
      for (const node of document.getElementById(id).querySelectorAll("*")) {
        if (node.offsetParent === null) continue;
        const box = node.getBoundingClientRect();
        /* A table may keep its own sideways scroll; the page itself may not. */
        if (box.width > window.innerWidth + 1 && !scrolls(node))
          out.push(`${node.tagName.toLowerCase()}.${node.className.toString().slice(0, 30)} = ${Math.round(box.width)}px`);
      }
      return out;
    }, holder);
    assert.deepEqual(tooWide, [], `${view} has something wider than a 400 px window`);
    const sideways = await f.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(sideways <= 1, `${view} makes the page scroll sideways by ${sideways}px`);
    /* The reading column must not gain a sideways bar of its own either. */
    const inColumn = await f.page.evaluate(() => {
      const column = document.querySelector("#settings-window:not([hidden]) .lx-settings-body") ?? document.getElementById("workspace");
      return column.scrollWidth - column.clientWidth;
    });
    assert.ok(inColumn <= 1, `${view} makes the reading column scroll sideways by ${inColumn}px`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 every control that can be seen can also be named", async (t) => {
  const f = await fixture(t);
  for (const [view, holder] of SCREENS) {
    await openScreen(f.page, view);
    const nameless = await f.page.evaluate((id) => {
      const out = [];
      for (const node of document.getElementById(id).querySelectorAll("button, input, select, textarea")) {
        if (node.offsetParent === null) continue;
        const name = node.labels?.[0]?.textContent?.trim() || node.getAttribute("aria-label") ||
          document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ||
          node.title || node.textContent.trim();
        if (!name) out.push(`${node.tagName.toLowerCase()}#${node.id || "(no id)"}`);
      }
      return out;
    }, holder);
    assert.deepEqual(nameless, [], `${view} has a control nothing can read out`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 a tick box sits beside its words, in the reading face", async (t) => {
  const f = await fixture(t);
  const wrong = [];
  for (const page of SETTINGS_PAGES) {
    await openScreen(f.page, `settings:${page}`);
    wrong.push(...await f.page.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll('#settings-window label > input[type="checkbox"]')) {
      if (box.offsetParent === null) continue;
      /* Stretched across the column is what used to put the tick on a line of its own. */
      if (box.getBoundingClientRect().width > 40) out.push(`${box.id}: the tick box is stretched`);
      if (getComputedStyle(box.parentElement).fontFamily.includes("Mono"))
        out.push(`${box.id}: its words are in the label face`);
    }
    return out;
    }));
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(f.errors, []);
});

test("Q4 every screen calls the same thing by the same name", async (t) => {
  const f = await fixture(t);
  /* One name per idea. Each pattern is a word the owner should never have to meet on its own;
     the second half of each pair is what to say instead. See docs/design.md, "The glossary". */
  const banned = [
    [/\bSKILL\.md\b/, "the instructions"],
    [/\bAPI base URL\b/, "web address of the service"],
    [/\bendpoint\b/i, "web address"],
    [/\bpayload\b/i, "what is sent"],
    [/\bSSE\b/, "live updates"],
  ];
  for (const [view, holder] of SCREENS) {
    await openScreen(f.page, view);
    const words = await f.page.evaluate((id) => document.getElementById(id).innerText, holder);
    for (const [pattern, instead] of banned)
      assert.equal(pattern.test(words), false, `${view} still says ${pattern} where it should say "${instead}"`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 every section says what it is for, and every card carries a title", async (t) => {
  const f = await fixture(t);
  for (const [view, holder] of SCREENS) {
    if (view === "chat") continue; /* the conversation opens on its greeting, not an intro */
    await openScreen(f.page, view);
    /* An old section keeps its own intro; a new tab is introduced by its place, a settings page by its own line. */
    const said = await f.page.evaluate((id) => {
      const node = document.getElementById(id);
      return Boolean(node.querySelector(".section-intro") || node.querySelector(".lx-page-intro") ||
        (!node.classList.contains("view") && node.closest(".lx-place")?.querySelector(".lx-place-intro")));
    }, holder);
    assert.ok(said, `${view} never says what it is for`);
    const untitled = await f.page.evaluate((id) => [...document.getElementById(id).querySelectorAll(".card")]
      .filter((card) => card.offsetParent !== null && !card.querySelector(
        card.classList.contains("settings-directory-card") ? "h3.settings-directory-title" : "h2, h3.settings-card-title, summary"))
      .map((card) => card.id || card.className), holder);
    assert.deepEqual(untitled, [], `${view} has a card with no title`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q5 Escape closes every popover this pass touched", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });

  await f.page.locator("#owner-menu-button").click();
  await f.page.locator("#owner-menu").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#owner-menu").waitFor({ state: "hidden" });
  assert.equal(await f.page.locator("#owner-menu-button").getAttribute("aria-expanded"), "false");

  /* The room meter moved into the new row under the message box; its numbers still close. */
  await f.page.evaluate(() => document.getElementById("meter-row").hidden = false);
  await f.page.locator("#meter-button").click();
  await f.page.locator("#meter-popover").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#meter-popover").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("Q5 the helper line and the room meter share one row, clear of the message box", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.getElementById("meter-row").hidden = false);
  const boxes = await f.page.evaluate(() => {
    const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { composer: rect(".composer"), foot: rect(".composer-foot"), meter: rect("#meter-row"), note: rect(".composer-foot .composer-note") };
  });
  assert.ok(boxes.foot.top >= boxes.composer.bottom - 1, "the quiet row still overlaps the message box");
  assert.ok(boxes.meter.left >= boxes.note.right - 1, "the meter and the helper line overlap each other");
  assert.deepEqual(f.errors, []);
});

test("Q5 focus can be seen, and stillness is honoured", async (t) => {
  const f = await fixture(t);
  const ring = await f.page.evaluate(() => {
    const probe = document.getElementById("prompt");
    probe.focus();
    const style = getComputedStyle(probe);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  assert.notEqual(ring.style, "none", "a focused control shows no ring");
  assert.notEqual(ring.width, "0px", "the focus ring has no width");

  /* "Keep things still" writes data-motion onto the page, and every move is then instant. */
  const still = await f.page.evaluate(() => {
    document.documentElement.dataset.motion = "reduced";
    const measured = getComputedStyle(document.getElementById("send")).transitionDuration;
    delete document.documentElement.dataset.motion;
    return measured;
  });
  assert.ok(Number.parseFloat(still) < 0.01,
    `movement is still ${still} long when the owner asked for stillness`);
  assert.deepEqual(f.errors, []);
});
