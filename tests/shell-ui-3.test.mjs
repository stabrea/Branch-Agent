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

/**
 * Wave 9 redesign and quality assurance — part 3 of 3
 * Rail management, structure, layouts, focus and popovers.
 */
import { SIZES, boxesHit, tabStops, openScreen, SCREENS, SETTINGS_PAGES } from "./shell-ui-helpers.mjs";
import { openSettingFor } from "./places.mjs";
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
    /* As in the sample, a Settings card may be titled by the section it sits in (the .sg-head matching its
       data-sg-bucket, public/settings-grown.js) rather than by a heading of its own; the same rule as
       tests/settings-descriptions.test.mjs. */
    const untitled = await f.page.evaluate((id) => {
      const sectionTitled = (card) => {
        const bucket = card.dataset.sgBucket;
        const head = bucket && [...(card.parentElement?.children ?? [])].find((node) => node.matches(".sg-head") && node.dataset.bucket === bucket);
        return Boolean(head?.querySelector("h3.sg-head-title")?.textContent.trim());
      };
      return [...document.getElementById(id).querySelectorAll(".card")]
        .filter((card) => card.offsetParent !== null && !sectionTitled(card) && !card.querySelector(
          card.classList.contains("settings-directory-card") ? "h3.settings-directory-title" : "h2, h3.settings-card-title, summary"))
        .map((card) => card.id || card.className);
    }, holder);
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
  /* The message box shows its focus as the sample's does (DG-175): the whole box takes the accent edge and ring,
     easing in over a moment, so it is read once it has arrived. */
  await f.page.evaluate(() => document.getElementById("prompt").focus());
  await f.page.waitForFunction(() => / 0px 0px 0px 3px\b/.test(` ${getComputedStyle(document.getElementById("chat-form")).boxShadow}`), null, { timeout: 3000 }).catch(() => undefined);
  const ring = await f.page.evaluate(() => {
    const box = getComputedStyle(document.getElementById("chat-form"));
    const probe = document.createElement("i");
    probe.style.color = "var(--copper)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { edge: box.borderTopColor === accent, ring: / 0px 0px 0px 3px\b/.test(` ${box.boxShadow}`) };
  });
  assert.deepEqual(ring, { edge: true, ring: true }, "a focused message box shows the accent edge and ring");

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
