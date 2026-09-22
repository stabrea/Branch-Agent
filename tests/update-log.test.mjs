/**
 * Owner item 19: an update that does not go through leaves Branch on the version it was, and says so
 * in one plain sentence with one button: "Download what happened". The file holds only what explains
 * the update (the hand-over's own steps, the update history, the activity log, crashes, disk, about),
 * already cleaned. The owner sends it to us themselves; nothing is sent by itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { zipRead } from "../dist/skill-package.js";
import { activationJournalName, openActivationJournal, settleActivation } from "../dist/never-break/activation.js";
import { openSettingFor } from "./places.mjs";
import { updateFailureApi } from "../dist/update-failure.js";

const secret = "sk-ant-api03-" + "x".repeat(48);
const steps = ["[10:00:01] app closed", "[10:00:02] keeping previous version", `[10:00:03] copying with ${secret}`, "[10:00:04] copy failed; putting the previous version back"];

/** A Branch whose last update did not go through: the hand-over wrote its steps, the journal says failed. */
async function failedUpdate(t, before = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-log-"));
  const dataDir = join(root, "data");
  // The hand-over writes into the system's temporary folder; this test gives Branch one of its own.
  const temp = join(root, "temp");
  await mkdir(join(temp, "branch-agent-update"), { recursive: true });
  await writeFile(join(temp, "branch-agent-update", "apply-update.log"), steps.join("\r\n") + "\r\n");
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => {
    await before();
    await server.close(); await app.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await discardTemp(root);
  });
  return { app, server, dataDir, root };
}
function stageAndFail(dataDir, to = "2.0.0") {
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: to, target: join(dataDir, "..", "installed"), previous: null, candidate: null,
    launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });
  journal.close();
  // The next start is still the version before: the hand-over put it back.
  assert.equal(settleActivation(join(dataDir, activationJournalName), "1.0.0"), "failed");
}
const call = (server, path, body, key = server.token) => fetch(server.url + "/api/" + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("a failed update is known after the restart, and its file holds only what explains it, cleaned", async (t) => {
  const { server, dataDir } = await failedUpdate(t);
  assert.deepEqual(await (await call(server, "updates/failure")).json(), { failure: null }, "no update yet, nothing to say");
  stageAndFail(dataDir);
  const { failure } = await (await call(server, "updates/failure")).json();
  assert.deepEqual([failure.fromVersion, failure.toVersion], ["1.0.0", "2.0.0"]);

  const saved = await (await call(server, "updates/failure-report", {})).json();
  assert.match(saved.name, /^branch-update-report-.*\.zip$/);
  const files = zipRead(Buffer.from(saved.base64, "base64"));
  assert.deepEqual([...files.keys()].sort(), ["README.txt", "about.txt", "crashes.txt", "disk.txt", "log.txt", "update-log.txt", "updates.txt"],
    "only what explains the update: no settings, tasks, services or network");
  const log = files.get("update-log.txt");
  for (const step of ["app closed", "keeping previous version", "copy failed; putting the previous version back"]) assert.ok(log.includes(step), step);
  assert.ok(!log.includes(secret), "cleaned like every other item");
  assert.match(files.get("updates.txt"), /"state": "failed"/);
  // A copy is kept in Branch's own folder too, and nothing was sent anywhere.
  assert.ok((await readFile(join(dataDir, "diagnostics", saved.name))).length > 0);
});

test("a later update that worked puts the failure away", async (t) => {
  const { server, dataDir } = await failedUpdate(t);
  stageAndFail(dataDir);
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.1", target: "x", previous: null, candidate: null,
    launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });
  journal.close();
  assert.equal(settleActivation(join(dataDir, activationJournalName), "2.0.1"), "activated");
  assert.deepEqual(await (await call(server, "updates/failure")).json(), { failure: null });
});

test("a household profile and a short-lived key can neither see the failure nor make its file", async (t) => {
  const { app, server, dataDir } = await failedUpdate(t);
  stageAndFail(dataDir);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call(server, "updates/failure", undefined, key)).status));
  assert.ok([401, 403].includes((await call(server, "updates/failure-report", {}, key)).status));
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call(server, "updates/failure")).status, 200);
  assert.notEqual((await call(server, "updates/failure-report", {})).status, 200);
  // The outer table answers first over the network; the route's own guard (which names itself) is
  // what stays if that table is ever refactored, so it is asked directly.
  const ctx = { app, dataDir, installType: "test", startedAt: Date.now() };
  for (const [method, path] of [["GET", "/api/updates/failure"], ["POST", "/api/updates/failure-report"]])
    await assert.rejects(updateFailureApi(ctx, method, path), /^Error: An update's problem report belongs to the owner/);
});

async function openApp(t, { desktop }) {
  const { chromium } = await import("playwright");
  // Launched before Branch is given its own temporary folder, and closed before that folder goes.
  const browser = await chromium.launch({ headless: true });
  const branch = await failedUpdate(t, () => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The desktop bridge, with a newer version ready whose install stops with a plain sentence.
  if (desktop) await page.addInitScript(() => {
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      checkForUpdates: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      installUpdate: async () => { throw new Error("The safety copy could not be made, so the update was stopped."); },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  });
  return { ...branch, page, errors };
}
async function connect(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#updates-card");
}

test("after a hand-over that put the version before back, the Updates card says so and hands over the file", async (t) => {
  const { page, server, dataDir, errors } = await openApp(t, { desktop: false });
  stageAndFail(dataDir);
  await connect(page, server);
  const text = page.locator("#updates-failed-text");
  await text.waitFor({ state: "visible" });
  assert.match(await text.textContent(), /The update to 2\.0\.0 didn't go through\. Branch stayed on .+, and nothing was lost\./);
  assert.equal(await page.locator("#updates-check").isVisible(), false, "without the desktop app only the failure shows");
  const download = page.waitForEvent("download");
  await page.locator("#updates-failed-log").click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^branch-update-report-.*\.zip$/);
  const names = [...zipRead(await readFile(await file.path())).keys()];
  assert.ok(names.includes("update-log.txt"));
  await page.waitForFunction(() => /Nothing was sent\./.test(document.querySelector("#updates-failed-saved")?.textContent ?? ""));
  assert.deepEqual(errors, []);
});

test("an install that stops here says it in plain words at once, in the language chosen", async (t) => {
  const { page, server, errors } = await openApp(t, { desktop: true });
  await connect(page, server);
  assert.equal(await page.locator("#updates-failed").isHidden(), true, "nothing to say before anything failed");
  await page.locator("#updates-install").waitFor({ state: "visible" });
  await page.locator("#updates-install").click();
  const text = page.locator("#updates-failed-text");
  await text.waitFor({ state: "visible" });
  assert.match(await text.textContent(), /^The update didn't go through\. Branch stayed on .+, and nothing was lost\.$/);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => /n'a pas abouti/.test(document.querySelector("#updates-failed-text")?.textContent ?? ""));
  // Checking again starts over: this attempt is put away.
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#updates-check").click();
  await page.waitForFunction(() => document.querySelector("#updates-failed")?.hidden === true);
  assert.deepEqual(errors, []);
});
