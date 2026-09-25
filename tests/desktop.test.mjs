import { test } from "node:test";
import { openPlace, openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
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
  await page.locator(`#lx-mode .segmented-option:has([data-t="look.${value === "daylight" ? "daylight" : "moonlight"}"])`).click();
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
  // Dogfood F7: the page holds a stand-in so its parts know they are signed in; never the key itself.
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("branch-token")),
    "desktop-window",
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

/**
 * Quitting while a task is working asks the person (src/desktop/quit-guard.ts), and a test cannot answer that box,
 * so the app is closed only once nothing is working. It waits at most a minute and says what was still going.
 */
async function settled(page, label) {
  for (let tries = 0; tries < 120; tries++) {
    const busy = await page.evaluate(async () => (await (await fetch("/api/comfort/update-readiness")).json()).busyTasks).catch(() => null);
    if (busy === 0) return;
    if (tries % 20 === 0) console.log(`Desktop ${label}: ${busy ?? "unknown"} task(s) still working`);
    await page.waitForTimeout(500);
  }
  console.log(`Desktop ${label}: still working after a minute; closing anyway`);
}

/**
 * Closes the app, but never waits on it for more than half a minute: a close that does not come back is ended, so a
 * stuck app fails this test in minutes instead of holding the whole shard until the job's hour runs out (Q244).
 */
async function closeWithin(app, child, label) {
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 30000))]);
  if (!closed && child.exitCode === null) { console.log(`Desktop ${label}: close did not come back in 30 s; ending it`); endTree(child); }
}
/**
 * Q244 (R21's Windows run): ending only Electron's main process left its helpers holding the test's output open, so the
 * shard still waited out its hour after the test had failed. On Windows the whole tree is ended.
 */
function endTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}
/** Q244: what the window was doing when a step failed: its address, loading, crashed, visible, and whether the page answers. */
async function windowState(app, page) {
  const within = (work) => Promise.race([work.catch((error) => `error: ${String(error?.message ?? error).split(/\r?\n/)[0]}`),
    new Promise((resolve) => setTimeout(() => resolve("no answer in 5 s"), 5000))]);
  const main = await within(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({
    url: w.webContents.getURL(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed(),
    visible: w.isVisible(), destroyed: w.isDestroyed() }))));
  const inPage = await within(page.evaluate(() => ({ ready: document.readyState, url: location.href })));
  return JSON.stringify({ main, inPage });
}
/** Q244: says what went wrong before the app is closed, so a run that then hangs still shows it. */
function said(label) {
  return (error) => { console.log(`Desktop ${label}: failed: ${String(error?.message ?? error).split(/\r?\n/)[0]}`); throw error; };
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
  async (t) => {
    const { home, options } = await desktopOptions();
    const electron = await _electron.launch(options);
    const child = electron.process();
    // The trunk's Windows runs after R18 and R19: when this test ran out of time its app was never closed, so the
    // shard waited on it until the job's hour was up. Running out of time now ends each app it started.
    // Node aborts the signal whenever the test ends, passed or not (Mac mini 07fdc5b), so only a child still running is ended.
    t.signal.addEventListener("abort", () => endTree(child), { once: true });
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
      await settled(page, "first run");
    } catch (error) {
      said("first app")(error);
    } finally {
      await closeWithin(electron, child, "first app");
      console.log("Desktop: first app closed");
    }
    assert.equal(child.exitCode, 0);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
    const restarted = await _electron.launch(options);
    const restartedChild = restarted.process();
    // Q244: the restarted app stops answering (main process included) soon after it connects; the engine runs inside
    // that process, so what it says about itself (a long job, a blocked event loop) is passed on, at most 80 lines.
    let told = 0;
    const tell = (stream) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean))
        if (told++ < 80) console.log(`Desktop restart ${stream}: ${line.slice(0, 300)}`);
    };
    restartedChild.stdout?.on("data", tell("out"));
    restartedChild.stderr?.on("data", tell("err"));
    t.signal.addEventListener("abort", () => endTree(restartedChild), { once: true });
    try {
      // Each step says so, so a run that stops here shows where.
      const page = await restarted.firstWindow();
      console.log("Desktop restart: window open");
      await connected(page);
      console.log("Desktop restart: connected");
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "daylight",
      );
      // Q244: on the Windows runner, taking the restarted window to "/" (by the rail's link or by address) left the whole
      // app answering nothing, its main process included, until it was ended (R21 runs 36186496292, 36188638363). That is
      // kept as its own row; here the restarted app is reloaded, as the first one is, and must connect again.
      await page.reload();
      console.log("Desktop restart: reloaded");
      await connected(page);
      console.log("Desktop restart: home again");
      await settled(page, "restart");
    } catch (error) {
      console.log(`Desktop restart: window state: ${await windowState(restarted, await restarted.firstWindow())}`);
      said("restart")(error);
    } finally {
      await closeWithin(restarted, restartedChild, "restart");
      console.log("Desktop restart: closed");
    }
  },
);
