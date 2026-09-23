/* DG-176 / DG-177 in the real desktop app (Electron; build machines only, never an owner's desktop): the window
   has no system title bar, its top row moves it while its buttons still press, the window's own controls follow
   the light, and it opens filling the screen, then the way it was left. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { connected, desktopOptions } from "./fixtures/desktop-options.mjs";

const mainWindow = (electron, run) => electron.evaluate(({ BrowserWindow }, body) => {
  const win = BrowserWindow.getAllWindows().find((each) => each.getTitle() !== "" && !each.isDestroyed()) ?? BrowserWindow.getAllWindows()[0];
  return new Function("win", body)(win);
}, `return (${run.toString()})(win);`);

test("the desktop window has no system title bar, fills the screen first, and reopens as it was left", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions();
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow();
    await connected(page);
    await page.waitForFunction(() => document.body.classList.contains("lx-desktop-frame"));
    assert.equal(await mainWindow(electron, (win) => win.isMaximized()), true, "the first launch fills the screen");
    const [outer, inner] = await mainWindow(electron, (win) => [win.getBounds().height, win.getContentBounds().height]);
    assert.equal(inner, outer, "no title bar sits above the app's own top row");
    const regions = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector("body.lx header")).webkitAppRegion,
      button: getComputedStyle(document.querySelector("body.lx header button")).webkitAppRegion,
    }));
    assert.deepEqual(regions, { header: "drag", button: "no-drag" }, "the top row moves the window; its buttons still press");
    assert.equal(await page.evaluate(() => window.branchDesktop.windowLook(false)), true);
    await assert.rejects(page.evaluate(() => window.branchDesktop.windowLook("#ff0000")), /Light or dark only/);
    await mainWindow(electron, (win) => { win.unmaximize(); win.setBounds({ x: 60, y: 60, width: 1100, height: 760 }); return true; });
    await page.waitForTimeout(800);
  } finally {
    await electron.close();
  }
  const again = await _electron.launch(options);
  try {
    const page = await again.firstWindow();
    await connected(page);
    assert.equal(await mainWindow(again, (win) => win.isMaximized()), false, "it reopens the way it was left");
    const bounds = await mainWindow(again, (win) => win.getNormalBounds());
    assert.deepEqual([bounds.width, bounds.height], [1100, 760]);
  } finally {
    await again.close();
  }
});
