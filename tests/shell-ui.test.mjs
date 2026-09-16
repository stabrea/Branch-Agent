import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SECTIONS = [
  "Conversation",
  "Activity",
  "Usage",
  "Memory",
  "Skills",
  "Specialists",
  "Procedures",
  "Schedules",
  "Settings",
];

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-shell-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
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

test("every section opens from the icon column in one click, with no drop-down", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.page.locator("select").filter({ hasText: "Memory" }).count(),
    0,
    "sections must not live in a drop-down",
  );
  for (const name of SECTIONS) {
    await f.page.getByRole("button", { name, exact: true }).click();
    await f.page.locator("#page-title").filter({ hasText: name }).waitFor();
  }
  assert.deepEqual(f.errors, []);
});

test("the command palette jumps to a section and closes on Escape", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.locator("#cmd-input").fill("Schedu");
  await f.page.locator(".cmd-item").first().click();
  assert.match(await f.page.locator("#page-title").innerText(), /Schedules/);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("all seven appearance controls apply at once and survive a reload", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: "Settings", exact: true }).click();
  await f.page.getByLabel("Appearance", { exact: true }).selectOption("daylight");
  await f.page.getByRole("button", { name: "Slate", exact: true }).click();
  await f.page.getByRole("button", { name: "Large", exact: true }).click();
  await f.page.getByRole("button", { name: "Compact", exact: true }).click();
  await f.page.getByRole("button", { name: "This computer's lettering", exact: true }).click();
  await f.page.locator("#appearance-motion").check();
  await f.page.locator("#appearance-acorn").uncheck();
  const chosen = {
    theme: "daylight",
    accent: "slate",
    textSize: "large",
    density: "compact",
    font: "system",
    motion: "reduced",
    acorn: "off",
  };
  assert.deepEqual(await look(f.page), chosen, "every choice shows straight away");
  assert.equal(await f.page.locator(".acorn-art").isVisible(), false);
  await f.page.getByRole("button", { name: "Save appearance", exact: true }).click();
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  await f.page.waitForFunction(() => document.documentElement.dataset.accent === "slate");
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
  assert.equal(kept.showAcorn, true);
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
  await f.page.getByRole("button", { name: "Memory", exact: true }).click();
  assert.match(await f.page.locator("#page-title").innerText(), /Memory/);
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
  await f.page.locator("#workspace").waitFor({ state: "visible" });
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
    await f.page.waitForTimeout(150);
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
  await f.page.locator("#workspace").waitFor({ state: "visible" });
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
      range.selectNodeContents(button);
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
  await f.page.getByLabel("Appearance", { exact: true }).selectOption("daylight");
  await f.page.getByRole("button", { name: "Conversation", exact: true }).click();
  await f.page.locator("#prompt").fill("Say hello");
  await f.page.getByRole("button", { name: "Send ↗", exact: true }).click();
  await f.page.locator("#conversation .message.assistant").first().waitFor({ timeout: 30000 });
  /* The rail fills itself when the workspace opens, so it is read after a reload. */
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  await f.page.locator("#rail-list .rail-line").first().waitFor({ timeout: 30000 });
  const row = f.page.locator("#rail-list .rail-line").first();
  const colour = () => row.evaluate((node) => getComputedStyle(node).backgroundColor);
  const resting = await colour();
  await row.hover();
  await f.page.waitForTimeout(150);
  const hovered = await colour();
  assert.notEqual(hovered, resting, "the row takes a background under the pointer");
  /* color-mix serialises as color(srgb r g b / a), so the alpha is the last part. */
  const alpha = Number.parseFloat(hovered.split("/").pop().replace(")", "").trim());
  assert.equal(alpha >= 0.09, true, `the wash is strong enough to see (${hovered})`);
  assert.deepEqual(f.errors, []);
});

test("Ctrl+Shift+K folds the context pane away and back", async (t) => {
  const f = await fixture(t);
  const open = () => f.page.locator("#context-panel").isVisible();
  assert.equal(await open(), true);
  await f.page.keyboard.press("Control+Shift+K");
  await f.page.waitForTimeout(150);
  assert.equal(await open(), false, "the pane folds away");
  await f.page.keyboard.press("Control+Shift+K");
  await f.page.waitForTimeout(150);
  assert.equal(await open(), true, "and comes back");
  assert.equal(await f.page.locator("#cmd-input").count(), 0, "the palette stays shut");
  assert.deepEqual(f.errors, []);
});

test("Tab walks the rail first, then the title bar, the messages and the composer", async (t) => {
  const f = await fixture(t);
  /* A reload puts the focus back at the top of the document before the walk. */
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
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

test("a folded Sections group stays folded, remembered for this workspace", async (t) => {
  const f = await fixture(t);
  const head = f.page.locator('.group-head[data-toggle="sections"]');
  await head.click();
  assert.equal(await head.getAttribute("aria-expanded"), "false");
  assert.equal(await f.page.locator("#sections-nav").isVisible(), false);
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  assert.equal(await head.getAttribute("aria-expanded"), "false", "it is still folded after a reload");
  const keys = await f.page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("branch-group-") && localStorage.getItem(key) === "closed"),
  );
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^branch-group-sections::.+/, "the choice is kept under this workspace's own name");
  /* A choice made before the workspace answered is still honoured. */
  await f.page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("branch-group-recents", "closed");
  });
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  assert.equal(
    await f.page.locator('.group-head[data-toggle="recents"]').getAttribute("aria-expanded"),
    "false",
  );
  assert.deepEqual(f.errors, []);
});

test("with nothing connected the context pane offers one thing to do", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.locator("#context-panel").getAttribute("data-connected"), "false");
  await f.page.locator("#context-connect").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#context-change-model").isVisible(), false);
  await f.page.locator("#context-connect").click();
  assert.match(await f.page.locator("#page-title").innerText(), /Settings/);
  assert.deepEqual(f.errors, []);
});

/* ==================== Wave 8: the design QA pass ====================
   Q3 nothing is wider than a 400 px window; Q4 the words on the screens are the words in the
   glossary; Q5 focus can be seen, Escape closes what it opened, and stillness is honoured. */

/** The ten screens the owner can open, as [what it is called, the rail's own name for it]. */
const SCREENS = [
  ["Conversation", "chat"], ["Activity", "runs"], ["Usage", "usage"], ["Memory", "memory"],
  ["Skills", "skills"], ["Specialists", "specialists"], ["Procedures", "procedures"],
  ["Schedules", "schedules"], ["Documents", "documents"], ["Settings", "settings"],
];

/** Opens a screen, letting the rail slide over first on a narrow window. */
async function openScreen(page, view) {
  const nav = page.locator(`.nav[data-view="${view}"]`).first();
  if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
  await nav.click();
  await page.evaluate(() => document.body.classList.remove("rail-open"));
  await page.waitForTimeout(350);
}

test("Q3 at 400 px nothing on any screen is wider than the window", async (t) => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 400, height: 800 });
  for (const [, view] of SCREENS) {
    await openScreen(f.page, view);
    const tooWide = await f.page.evaluate((id) => {
      const scrolls = (node) => {
        for (let p = node; p; p = p.parentElement) {
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
    }, view);
    assert.deepEqual(tooWide, [], `${view} has something wider than a 400 px window`);
    const sideways = await f.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(sideways <= 1, `${view} makes the page scroll sideways by ${sideways}px`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 every control that can be seen can also be named", async (t) => {
  const f = await fixture(t);
  for (const [, view] of SCREENS) {
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
    }, view);
    assert.deepEqual(nameless, [], `${view} has a control nothing can read out`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 a tick box sits beside its words, in the reading face", async (t) => {
  const f = await fixture(t);
  await openScreen(f.page, "settings");
  const wrong = await f.page.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll('#settings label > input[type="checkbox"]')) {
      if (box.offsetParent === null) continue;
      /* Stretched across the column is what used to put the tick on a line of its own. */
      if (box.getBoundingClientRect().width > 40) out.push(`${box.id}: the tick box is stretched`);
      if (getComputedStyle(box.parentElement).fontFamily.includes("Mono"))
        out.push(`${box.id}: its words are in the label face`);
    }
    return out;
  });
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
  for (const [, view] of SCREENS) {
    await openScreen(f.page, view);
    const words = await f.page.evaluate((id) => document.getElementById(id).innerText, view);
    for (const [pattern, instead] of banned)
      assert.equal(pattern.test(words), false, `${view} still says ${pattern} where it should say "${instead}"`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 every section says what it is for, and every card carries a title", async (t) => {
  const f = await fixture(t);
  for (const [, view] of SCREENS) {
    if (view === "chat") continue; /* the conversation opens on its greeting, not an intro */
    await openScreen(f.page, view);
    assert.ok(await f.page.locator(`#${view} .section-intro`).count(), `${view} never says what it is for`);
    const untitled = await f.page.evaluate((id) => [...document.getElementById(id).querySelectorAll(".card")]
      .filter((card) => card.offsetParent !== null && !card.querySelector("h2, summary"))
      .map((card) => card.id || card.className), view);
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
