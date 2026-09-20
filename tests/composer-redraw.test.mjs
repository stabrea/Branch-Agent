import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-composer-redraw-"));
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

  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });
  return { page };
}

test("composer text, caret, and selection survive 3-second refresh cycle", async (t) => {
  const { page } = await fixture(t);

  // Wait for the page to fully initialize
  await page.waitForSelector("#prompt");

  // Type a half-finished sentence into the composer
  const prompt = page.locator("#prompt");
  await prompt.click();
  const testText = "Build me a todo app with";
  await prompt.type(testText, { delay: 10 });

  // Set a non-collapsed selection (select middle part of typed text)
  const selectionStart = 10; // "Build me a"
  const selectionEnd = 18; // "Build me a todo "
  await prompt.evaluate(
    (el, start, end) => {
      el.selectionStart = start;
      el.selectionEnd = end;
    },
    selectionStart,
    selectionEnd
  );

  // Wait for the 3-second refresh to fire (plus a small buffer)
  await page.waitForTimeout(3500);

  // Assert all three elements of the text input state are unchanged
  const value = await prompt.inputValue();
  assert.equal(
    value,
    testText,
    `Text was lost or changed during redraw. Expected "${testText}", got "${value}"`
  );

  const activeElement = await page.evaluate(() => document.activeElement?.id);
  assert.equal(
    activeElement,
    "prompt",
    `Focus was moved away from #prompt during redraw. Active element: ${activeElement}`
  );

  const currentSelectionStart = await prompt.evaluate((el) => el.selectionStart);
  assert.equal(
    currentSelectionStart,
    selectionStart,
    `Selection start was moved from ${selectionStart} to ${currentSelectionStart}`
  );

  const currentSelectionEnd = await prompt.evaluate((el) => el.selectionEnd);
  assert.equal(
    currentSelectionEnd,
    selectionEnd,
    `Selection end was moved from ${selectionEnd} to ${currentSelectionEnd}`
  );
});

test("composer bar layout: no wrapping at 1440×950 with panel closed", async (t) => {
  const { page } = await fixture(t);

  // Set viewport to 1440×950
  await page.setViewportSize({ width: 1440, height: 950 });

  // Close the side panel if it's open
  await page.evaluate(() => {
    const panelToggle = document.querySelector(".panel-toggle");
    if (panelToggle && !panelToggle.hidden) {
      panelToggle.click();
    }
  });

  // Wait for layout stabilization
  await page.waitForTimeout(500);

  // Get all direct children of .composer and their top positions
  const childPositions = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    if (!composer) return null;
    const children = Array.from(composer.children);
    return {
      composerHeight: composer.getBoundingClientRect().height,
      distinctTopValues: new Set(
        children.map((child) => Math.round(child.getBoundingClientRect().top))
      ).size,
      childCount: children.length,
      childTops: children.map((child) => ({
        className: child.className,
        top: Math.round(child.getBoundingClientRect().top),
        height: child.getBoundingClientRect().height,
      })),
    };
  });

  if (!childPositions) {
    throw new Error("Could not find .composer element");
  }

  console.log("Composer layout at 1440×950 (panel closed):");
  console.log(`  Height: ${childPositions.composerHeight}px`);
  console.log(`  Children with distinct top positions: ${childPositions.distinctTopValues}`);
  console.log("  Child details:");
  for (const child of childPositions.childTops) {
    console.log(`    ${child.className || "(div)"}: top=${child.top}, height=${child.height}`);
  }

  // The bar should not wrap: all direct children should be on the same line
  // (i.e., have only one distinct top position)
  assert.equal(
    childPositions.distinctTopValues,
    1,
    `Composer children wrapped across multiple lines. Expected 1 distinct top position, found ${childPositions.distinctTopValues}`
  );
});

test("Send button does not wrap at 1440×950 and 1024×700", async (t) => {
  const { page } = await fixture(t);

  for (const [width, height] of [
    [1440, 950],
    [1024, 700],
  ]) {
    await page.setViewportSize({ width, height });

    // Close the side panel if it's open
    await page.evaluate(() => {
      const panelToggle = document.querySelector(".panel-toggle");
      if (panelToggle && !panelToggle.hidden) {
        panelToggle.click();
      }
    });

    await page.waitForTimeout(300);

    // Check that #send is still on the same line as its siblings
    const sendPosition = await page.evaluate(() => {
      const composer = document.querySelector(".composer");
      const send = document.querySelector("#send");
      if (!composer || !send) return null;
      const composerRect = composer.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      const childTops = Array.from(composer.children)
        .map((child) => Math.round(child.getBoundingClientRect().top))
        .filter((top) => top !== sendRect.top); // other children's positions
      return {
        sendTop: Math.round(sendRect.top),
        otherChildTops: childTops,
        distinctTops: new Set([Math.round(sendRect.top), ...childTops]).size,
      };
    });

    if (!sendPosition) {
      throw new Error("Could not find .composer or #send");
    }

    console.log(`At ${width}×${height}:`);
    console.log(`  #send top position: ${sendPosition.sendTop}`);
    console.log(`  Other children top positions: ${[...new Set(sendPosition.otherChildTops)].join(", ")}`);
    console.log(`  Distinct top positions: ${sendPosition.distinctTops}`);

    assert.equal(
      sendPosition.distinctTops,
      1,
      `At ${width}×${height}: Send button wrapped. Distinct top positions: ${sendPosition.distinctTops}`
    );
  }
});
