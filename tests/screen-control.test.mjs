// Using this computer's screen and keyboard. Every window these tests touch is one they opened
// themselves — a Notepad window and a small window of their own standing in for a password
// manager — and every one of them is closed again, whether the test passes or fails.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createBranch, isReadOnlyPermission, savePolicy } from "../dist/index.js";
import {
  keyChord, readDesktopSettings, refusalFor, saveDesktopSettings, secretReferenceIn, switchedOffMessage,
} from "../dist/integrations/desktop-config.js";
import { bannerTitle } from "../dist/integrations/desktop-banner.js";
import { startServer } from "../dist/server.js";

const notepad = "C:/Windows/System32/notepad.exe";
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-screen-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const run = app.store.createRun("local", "screen control fixture");
  return { app, root, run, context: () => app.runtime.context({ runId: run.id }) };
}
/** A Notepad window of this test's own, closed again however the test ends. */
async function openNotepad(t, app, name) {
  const path = join(app.runtime.workspace, name);
  await writeFile(path, "start here\n", "utf8");
  const child = spawn(notepad, [path], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await pause(3000);
  return path;
}
/** A window of this test's own wearing a password manager's name, to prove such windows are refused. */
async function fakeVaultWindow(t, title) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.Form",
    `$f.Text = '${title}'`,
    "$f.Width = 300; $f.Height = 160; $f.TopMost = $true",
    "[void]$f.ShowDialog()",
  ].join("; ");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await pause(2500);
}
const actionsIn = (app, runId) => app.store.events(runId).filter((event) => event.kind === "desktop.action");

test("the switch is off until the owner turns it on, and then every screen tool says so plainly", async (t) => {
  const f = await fixture(t);
  assert.equal(readDesktopSettings(f.app.store, "local").enabled, false, "off out of the box");
  const attempts = [
    ["desktop.screenshot", {}],
    ["desktop.windows", { action: "list" }],
    ["desktop.read", { window: "Notepad" }],
    ["desktop.click", { window: "Notepad", name: "File" }],
    ["desktop.type", { window: "Notepad", text: "hello" }],
    ["desktop.key", { window: "Notepad", chord: "ctrl+s" }],
    ["desktop.open", { app: "notepad" }],
    ["desktop.clipboard", { action: "read" }],
  ];
  for (const [tool, args] of attempts) {
    await assert.rejects(() => f.app.registry.execute(tool, args, f.context()),
      (error) => error.message === switchedOffMessage, `${tool} went ahead with the switch off`);
  }
  assert.equal(actionsIn(f.app, f.run.id).length, 0, "nothing touched the screen");
  const settings = saveDesktopSettings(f.app.store, "local", { enabled: true });
  assert.equal(settings.enabled, true);
  assert.equal(settings.maxActionsPerRun, 40, "an allowance comes with the switch");
});

test("every screen tool counts as a change, so 'Ask before changes' stops and asks first", async (t) => {
  for (const permission of ["desktop.view", "desktop.control", "desktop.clipboard"])
    assert.equal(isReadOnlyPermission(permission), false, `${permission} must never count as merely looking`);
  // One that only looks, and one that acts: both are stopped before the screen is touched.
  const wanted = [
    { name: "desktop.windows", arguments: JSON.stringify({ action: "list" }) },
    { name: "desktop.type", arguments: JSON.stringify({ window: "Notepad", text: "hello" }) },
  ];
  let next = 0;
  const provider = {
    name: "scripted",
    rounds: 0,
    async complete() {
      provider.rounds += 1;
      return { content: "", toolCalls: [{ id: `c${provider.rounds}`, ...wanted[next] }] };
    },
  };
  const f = await fixture(t, provider);
  saveDesktopSettings(f.app.store, "local", { enabled: true });
  savePolicy(f.app.store, "local", { preset: "ask-before-changes" });
  const server = await startServer(f.app, { dataDir: join(f.root, "data"), port: 0 });
  t.after(() => server.close());
  for (next = 0; next < wanted.length; next += 1) {
    const response = await fetch(server.url + "/api/run", {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "use my screen" }),
    });
    const paused = await response.json();
    assert.equal(paused.status, "needs_input", `${wanted[next].name}: ${paused.output}`);
    assert.match(paused.output, /Is that all right\?/);
    const waiting = f.app.runtime.approvals.waiting(paused.sessionId).at(-1);
    assert.equal(waiting.tool, wanted[next].name, "the question names the tool that was stopped");
    assert.ok(f.app.store.events(paused.id).some((event) => event.kind === "policy.ask"), "the question was written down");
    assert.equal(actionsIn(f.app, paused.id).length, 0, "the screen was not touched while it waited");
  }
});

test("with the switch on, Branch can see, read, type into and photograph a window it opened", async (t) => {
  const f = await fixture(t);
  saveDesktopSettings(f.app.store, "local", { enabled: true });
  await openNotepad(t, f.app, "screentest.txt");

  const listed = await f.app.registry.execute("desktop.windows", { action: "list" }, f.context());
  const mine = listed.windows.filter((window) => window.title.includes("screentest"));
  assert.equal(mine.length, 1, `the window this test opened is listed: ${listed.windows.map((w) => w.title).join(" | ")}`);
  assert.equal(mine[0].offLimits, false);

  const read = await f.app.registry.execute("desktop.read", { window: "screentest", limit: 60 }, f.context());
  const editor = read.parts.find((part) => part.role === "Document");
  assert.ok(editor, "the window's writing area is described by name, not by pixels");
  assert.match(editor.value, /start here/);

  const typed = await f.app.registry.execute("desktop.type", { window: "screentest", text: "branch typed this" }, f.context());
  assert.equal(typed.how, "set", "typing goes through the accessibility layer, not through key presses");
  const again = await f.app.registry.execute("desktop.read", { window: "screentest", limit: 60 }, f.context());
  assert.equal(again.parts.find((part) => part.role === "Document").value, "branch typed this");

  const picture = await f.app.registry.execute("desktop.screenshot", { window: "screentest" }, f.context());
  assert.equal(picture.mediaType, "image/png");
  assert.ok(picture.bytes > 1000 && picture.sha256.length === 64, "a real picture was kept as an artifact");
  const bytes = await f.app.artifacts.read(picture.path);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");

  const closed = await f.app.registry.execute("desktop.windows", { action: "close", window: "screentest" }, f.context());
  assert.equal(closed.action, "close");
  const record = actionsIn(f.app, f.run.id).map((event) => `${event.data.tool} on ${event.data.window}`);
  assert.ok(record.some((line) => line.startsWith("desktop.type on screentest")), `every action names its window: ${record.join(", ")}`);
});

test("a notice with a Stop button is on screen while Branch is using it, and it can be photographed", async (t) => {
  const f = await fixture(t);
  saveDesktopSettings(f.app.store, "local", { enabled: true });
  const listed = await f.app.registry.execute("desktop.windows", { action: "list" }, f.context());
  assert.ok(listed.windows.some((window) => window.title === bannerTitle), `the notice is up: ${listed.windows.map((w) => w.title).join(" | ")}`);
  const picture = await f.app.registry.execute("desktop.screenshot", { window: bannerTitle }, f.context());
  assert.equal(picture.mediaType, "image/png");
  assert.ok(picture.width >= 400 && picture.height >= 40, "the notice is a real window of its own");
  // Pressing Stop is the same as cancelling the task: the screen is let go of at once.
  f.app.desktop.stop(f.run.id);
  await assert.rejects(() => f.app.registry.execute("desktop.windows", { action: "list" }, f.context()),
    /You pressed Stop/);
  await f.app.desktop.closeRun({ runId: f.run.id });
});

test("a task may only use the screen so many times", async (t) => {
  const f = await fixture(t);
  saveDesktopSettings(f.app.store, "local", { enabled: true, maxActionsPerRun: 2 });
  await f.app.registry.execute("desktop.windows", { action: "list" }, f.context());
  await f.app.registry.execute("desktop.windows", { action: "list" }, f.context());
  await assert.rejects(() => f.app.registry.execute("desktop.windows", { action: "list" }, f.context()),
    /already used the screen 2 times/);
  await f.app.desktop.closeRun({ runId: f.run.id });
});

test("switching it off part way through stops the task that is already using the screen", async (t) => {
  const f = await fixture(t);
  saveDesktopSettings(f.app.store, "local", { enabled: true });
  const listed = await f.app.registry.execute("desktop.windows", { action: "list" }, f.context());
  assert.ok(listed.windows.length > 0, "it was working a moment ago");
  saveDesktopSettings(f.app.store, "local", { enabled: false });
  for (const [tool, args] of [["desktop.windows", { action: "list" }], ["desktop.read", { window: "Notepad" }]])
    await assert.rejects(() => f.app.registry.execute(tool, args, f.context()),
      (error) => error.message === switchedOffMessage, `${tool} carried on after the switch went off`);
  await f.app.desktop.closeRun({ runId: f.run.id });
});

test("a window that looks like a password manager is never photographed or typed into", async (t) => {
  const f = await fixture(t);
  saveDesktopSettings(f.app.store, "local", { enabled: true });
  await fakeVaultWindow(t, "Bitwarden");
  for (const [what, args] of [["one window", { window: "Bitwarden" }], ["the whole screen", { display: 1 }]])
    await assert.rejects(() => f.app.registry.execute("desktop.screenshot", args, f.context()),
      /password/i, `${what} was photographed anyway`);
  await assert.rejects(() => f.app.registry.execute("desktop.type", { window: "Bitwarden", text: "hello" }, f.context()), /password/i);
  await assert.rejects(() => f.app.registry.execute("desktop.click", { window: "Bitwarden", name: "OK" }, f.context()), /password/i);
  assert.equal(actionsIn(f.app, f.run.id).filter((event) => event.data.window === "Bitwarden").length, 0);
  await f.app.desktop.closeRun({ runId: f.run.id });
});

test("the Settings card starts unticked and ticking it is what turns the tools on", async (t) => {
  const f = await fixture(t);
  const server = await startServer(f.app, { dataDir: join(f.root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((token) => sessionStorage.setItem("branch-token", token), server.token);
  await page.goto(server.url);
  await page.getByRole("button", { name: "Settings" }).first().click();
  const toggle = page.locator("#desktop-enabled");
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false, "the card opens unticked");
  assert.match(await page.locator("#desktop-card").innerText(), /Stop/, "the card says how to stop it");
  await toggle.check();
  await page.locator("#desktop-cap-row").waitFor({ state: "visible" });
  assert.equal(readDesktopSettings(f.app.store, "local").enabled, true, "ticking the box is what switches it on");
  await toggle.uncheck();
  await page.waitForFunction(() => document.getElementById("desktop-off-note")?.hidden === false);
  assert.equal(readDesktopSettings(f.app.store, "local").enabled, false);
});

test("refusals, key names and saved-password references are decided before anything is touched", () => {
  assert.equal(refusalFor({ title: "Untitled - Notepad", program: "notepad" }), null);
  assert.match(refusalFor({ title: "Bitwarden - Chrome", program: "chrome" }), /password or sign-in/);
  assert.match(refusalFor({ title: "Sign in to your account", program: "chrome" }), /password or sign-in/);
  assert.match(refusalFor({ title: "Anything", program: "LogonUI" }), /handles passwords/);
  assert.equal(keyChord("ctrl+s"), "^s");
  assert.equal(keyChord("enter"), "{ENTER}");
  assert.equal(keyChord("ctrl+shift+f5"), "^+{F5}");
  assert.throws(() => keyChord("ctrl+{DEL}"), /not a key Branch knows/);
  assert.throws(() => keyChord("win+l"), /hold down/);
  assert.match(secretReferenceIn("my password is {{VAULT_KEY}}"), /placeholder/);
  assert.match(secretReferenceIn("token %BRANCH_TOKEN%"), /saved password/);
  assert.equal(secretReferenceIn("an ordinary sentence"), null);
});
