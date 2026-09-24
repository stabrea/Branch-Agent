/**
 * Wave 9 redesign and quality assurance — part 1 of 3
 * Sidebar, place navigation, Q3 narrow window, Q4 appearance, rail behaviors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture, PLACES, SIZES, openScreen, SCREENS, look } from "./shell-ui-helpers.mjs";
import { openSettingFor } from "./places.mjs";

test("the sidebar starts with this real computer and keeps project switching available", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.locator(".rail-head #rail-target-name").textContent(), "This computer");
  assert.match(await f.page.locator("#app-switcher").ariaSnapshot(), /button "This computer/,
    "the visible computer name is part of the switcher's accessible name");
  assert.equal(await f.page.locator("#brand-name").count(), 0, "the old app-name header is not built invisibly");
  await f.page.locator("#rail-target-mark .face-computer").waitFor();
  assert.equal(await f.page.locator(".rail-scroll #rail-target").count(), 0, "the identity is not repeated below the actions");

  const saved = await fetch(`${f.server.url}/api/reach/machine-name`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "studio-mac" }),
  });
  assert.equal(saved.status, 200);
  await f.page.evaluate(async () => (await import("/shell.js")).loadRail());
  assert.equal(await f.page.locator(".rail-head #rail-target-name").textContent(), "studio-mac");
  assert.match(await f.page.locator("#app-switcher").ariaSnapshot(), /button "studio-mac/);
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await f.page.locator(".rail-head #rail-target-name").filter({ hasText: "studio-mac" }).waitFor();

  await f.page.locator("#app-switcher").click();
  assert.equal(await f.page.locator("#app-menu").isVisible(), true, "project switching still works");
  for (const width of [1440, 1024]) {
    await f.page.setViewportSize({ width, height: 900 });
    const fits = await f.page.locator("#app-switcher").evaluate((button) => {
      const head = button.closest(".rail-head").getBoundingClientRect();
      const identity = button.querySelector("#rail-target-name").getBoundingClientRect();
      return identity.left >= head.left && identity.right <= head.right;
    });
    assert.equal(fits, true, `the computer name fits the sidebar header at ${width}px`);
  }
  assert.deepEqual(f.errors, []);
});

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
  // As in the sample, a conversation opens from the side list's New conversation; there is no Conversation button.
  assert.equal(await f.page.getByRole("button", { name: "Conversation", exact: true }).count(), 0);
  await f.page.locator("#rail-new").click();
  await f.page.locator("#chat").waitFor({ state: "visible" });
  await f.page.locator("#page-title").filter({ hasText: "Conversation" }).waitFor({ state: "attached" });
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

test("Q4 a tick box sits beside its words, in the reading face", async (t) => {
  const f = await fixture(t);
  const SETTINGS_PAGES = ["general", "assistant", "instructions", "appearance", "notifications", "models", "accounts", "voice", "permissions",
    "computer", "secrets", "data", "advanced", "about", "trunks", "channels", "connections", "skills", "memory", "automations"];
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

test("every appearance control applies at once and survives a reload", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#appearance");
  await f.page.getByRole("button", { name: "Daylight", exact: true }).click();
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
  await f.page.locator("#lx-foot-theme").click(); // DG-159: the leaf in the sidebar's foot
  await f.page.locator("#appearance-motion").check();
  assert.equal((await speed()) < 0.01, true, "so does the Appearance choice");
  assert.deepEqual(f.errors, []);
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
