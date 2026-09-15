import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron } from "playwright";

async function desktopOptions() {
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "Temp", "Codex-session-files")
      : tmpdir();
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, "branch-agent-desktop-"));
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "HOME",
      "DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const launch = process.env.BRANCH_PACKAGED_EXECUTABLE
    ? { executablePath: process.env.BRANCH_PACKAGED_EXECUTABLE, args: [] }
    : { args: [root] };
  return {
    home,
    options: {
      ...launch,
      timeout: 30000,
      chromiumSandbox: true,
      env: {
        ...env,
        BRANCH_PROVIDER: "demo",
        BRANCH_DESKTOP_HOME: home,
        BRANCH_DATA_DIR: join(home, "state"),
        BRANCH_WORKSPACE: join(home, "workspace"),
      },
    },
  };
}

async function appearance(page, value) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption(value);
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await page.waitForFunction(
    (value) => document.documentElement.dataset.theme === value,
    value,
  );
}

async function verifyWindow(electron, page, home) {
  await page.getByText("Connected", { exact: true }).waitFor();
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
  await page
    .getByLabel("Your message", { exact: true })
    .fill("Run the file workflow.");
  await page.getByRole("button", { name: "Send ↗", exact: true }).click();
  await page.locator(".message.assistant").waitFor();
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
      try {
        await BrowserWindow.getAllWindows()[0].loadURL(target);
      } catch {}
    }, target);
    assert.equal(hits, 0);
    await electron.evaluate(
      ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
      original,
    );
    await page.getByText("Connected", { exact: true }).waitFor();
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
  { timeout: 90000 },
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
      await page.getByText("Connected", { exact: true }).waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "daylight",
      );
      await appearance(page, "forest");
      await page
        .getByRole("button", { name: "Conversation", exact: true })
        .click();
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
      await page.getByText("Connected", { exact: true }).waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "daylight",
      );
      await page.getByRole("link", { name: "Branch Agent home" }).click();
      await page.getByText("Connected", { exact: true }).waitFor();
    } finally {
      await restarted.close();
    }
  },
);
