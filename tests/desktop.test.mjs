import { test } from "node:test";
import { openPlace, openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron } from "playwright";

import { connected, desktopOptions } from "./fixtures/desktop-options.mjs";

/* Redesign phase 1: a conversation begun in the window starts on Ask first, and the practice run writes
   a file. This checks the desktop app, so its conversation follows the setting as before
   (tests/conversation-mode.test.mjs covers Ask first). */
const followSetting = (page) => page.evaluate(async () => {
  await fetch("/api/conversation-mode/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newConversation: "follow" }) });
  await globalThis.branchConversationMode?.refresh();
});

async function appearance(page, value) {
  await openSettingFor(page, "#appearance");
  await page.locator(`.lx-seg-button[data-t="look.mode.${value === "daylight" ? "light" : "dark"}"]`).click();
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await page.waitForFunction(
    (value) => document.documentElement.dataset.theme === value,
    value,
  );
}

async function verifyWindow(electron, page, home) {
  await connected(page);
  assert.match(await page.title(), /Branch Agent/);
  const isolation = await electron.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      context: p.contextIsolation,
      sandbox: p.sandbox,
    };
  });
  assert.deepEqual(isolation, { node: false, context: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const token = (
    await readFile(join(home, "state", "session-token"), "utf8")
  ).trim();
  assert.equal(page.url().includes(token), false);
  assert.equal((await page.content()).includes(token), false);
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("branch-token")),
    null,
  );
  await followSetting(page);
  await page
    .getByLabel("Your message", { exact: true })
    .fill("Run the file workflow.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".message.assistant").waitFor({ timeout: 30000 });
  assert.equal(
    await readFile(join(home, "workspace", "branch-demo.txt"), "utf8"),
    "Hello from Branch.\n",
  );
}

async function verifyNetworkBoundary(electron, page) {
  let hits = 0;
  const outside = createServer((_request, response) => {
    hits++;
    response.end("outside");
  });
  outside.listen(0, "127.0.0.1");
  await once(outside, "listening");
  const original = page.url(),
    target = `http://127.0.0.1:${outside.address().port}`;
  try {
    await electron.evaluate(async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      try {
        await contents.loadURL(target);
      } catch {}
      /* The refused load is reported before the window has stopped loading. Loading the page again
         in between made that late stop end the new load instead ("ERR_FAILED (-2) loading" the
         app's own address, seen on Linux), so the window is let finish first. */
      if (contents.isLoading())
        await new Promise((done) => contents.once("did-stop-loading", done));
    }, target);
    assert.equal(hits, 0);
    await electron.evaluate(
      ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
      original,
    );
    await connected(page);
    assert.equal(
      await page.evaluate(() => window.open("https://example.com") === null),
      true,
    );
    assert.equal(
      await electron.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
  } finally {
    outside.close();
    await once(outside, "close");
  }
}

test(
  "native desktop authenticates locally, completes work, persists appearance, and hides to tray",
  { timeout: 360000 },
  async () => {
    const { home, options } = await desktopOptions();
    const electron = await _electron.launch(options);
    const child = electron.process();
    let url;
    try {
      const page = await electron.firstWindow();
      await verifyWindow(electron, page, home);
      url = page.url();
      await verifyNetworkBoundary(electron, page);
      await appearance(page, "daylight");
      await page.reload();
      await connected(page);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "daylight",
      );
      await appearance(page, "forest");
      /* Settings is a window over whatever place you were on, so after saving the appearance the
         place behind it is still the conversation and .lx-back is hidden -- a click on it waits
         thirty seconds and fails. Going back to the conversation is what this wants, and
         places.mjs knows how: close the window, and only then use the back button if it is there. */
      await openPlace(page, "chat");
      await page.screenshot({ path: join(home, "desktop.png") });
      await appearance(page, "daylight");
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].close(),
      );
      assert.equal(
        await electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
        false,
      );
      console.log(`Desktop screenshot: ${join(home, "desktop.png")}`);
    } finally {
      await electron.close();
    }
    assert.equal(child.exitCode, 0);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
    const restarted = await _electron.launch(options);
    try {
      const page = await restarted.firstWindow();
      await connected(page);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "daylight",
      );
      await page.getByRole("link", { name: "Branch Agent home" }).click();
      await connected(page);
    } finally {
      await restarted.close();
    }
  },
);
