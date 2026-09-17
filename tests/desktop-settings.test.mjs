import { test } from "node:test";
import { openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron } from "playwright";
import { desktopOptions } from "./fixtures/desktop-options.mjs";
import { DesktopSettings } from "../dist/desktop/settings.js";

test("desktop settings reject key reuse across destinations and unavailable encryption", async () => {
  const { home } = await desktopOptions();
  const file = join(home, "model-settings.json");
  const encryption = {
    available: () => true,
    encrypt: (value) => Buffer.from(`fixture:${value}`),
    decrypt: (value) => value.toString().slice(8),
  };
  const settings = new DesktopSettings(file, encryption);
  const input = { provider: "openai", endpoint: "http://localhost:1234/v1",
    model: "fixture", apiKey: "test-only" };
  await settings.load();
  await settings.save(input);
  await settings.save({ ...input, model: "changed", apiKey: "" });
  await assert.rejects(settings.save({ ...input, endpoint: "http://localhost:4321/v1",
    apiKey: "" }), /Enter an API key/);
  await assert.rejects(settings.save({ ...input, provider: "anthropic", apiKey: "" }), /Enter an API key/);
  assert.equal(settings.environment().BRANCH_API_KEY, "test-only");
  const reloaded = new DesktopSettings(file, encryption);
  await reloaded.load();
  assert.equal(reloaded.summary().model, "changed");
  const unavailable = new DesktopSettings(file, { ...encryption, available: () => false });
  await unavailable.load();
  await assert.rejects(unavailable.save(input), /unavailable/);
  assert.throws(() => unavailable.environment(), /unavailable/);
  await reloaded.save({ provider: "demo", endpoint: "", model: "", apiKey: "" });
  assert.equal(reloaded.summary().hasKey, false);
});

async function fixtureProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: {
      role: "assistant", content: "Saved connection is working.",
    } }], usage: { prompt_tokens: 12, completion_tokens: 6 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, requests, endpoint: `http://127.0.0.1:${server.address().port}/v1` };
}

test("native settings encrypt a key, keep IPC narrow, and connect after restart", {
  timeout: 90000,
}, async () => {
  const { home, options } = await desktopOptions();
  delete options.env.BRANCH_PROVIDER;
  const provider = await fixtureProvider();
  let electron;
  try {
    electron = await _electron.launch(options);
    const firstChild = electron.process();
    const page = await electron.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByText("Connected", { exact: true }).waitFor();
    await openSettingFor(page, "#model-provider");
    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    await page.getByLabel("Web address of the service", { exact: true }).fill(provider.endpoint);
    await page.getByLabel("Model identifier", { exact: true }).fill("fixture-model");
    await page.getByLabel("API key", { exact: true }).fill("fixture-device-key-82743");
    await page.getByRole("button", { name: "Save model connection", exact: true }).click();
    await page.getByText("Connection saved. Quit from the tray and reopen Branch Agent to apply it.").waitFor();
    const disk = await readFile(join(home, "model-settings.json"), "utf8");
    assert.equal(disk.includes("fixture-device-key-82743"), false);
    const summary = await page.evaluate(() => window.branchDesktop.modelSettings());
    assert.equal(summary.hasKey, true);
    assert.equal("encryptedKey" in summary, false);
    assert.equal("apiKey" in summary, false);
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
    await page.screenshot({ path: join(home, "model-settings.png"), fullPage: true });
    console.log(`Model settings screenshot: ${join(home, "model-settings.png")}`);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.branchDesktop).sort()),
      ["checkForUpdates", "exportBackup", "exportConversation", "exportMemory", "installUpdate", "modelSettings", "openExternal", "saveModelSettings", "updateStatus"]);
    await verifyOtherWindowDenied(electron, page.url());
    await electron.close();
    assert.equal(firstChild.exitCode, 0);
    electron = undefined;
    electron = await _electron.launch(options);
    const restarted = await electron.firstWindow();
    restarted.setDefaultTimeout(10000);
    await restarted.getByText("Connected", { exact: true }).waitFor();
    await restarted.getByLabel("Your message", { exact: true }).fill("Test the saved model connection.");
    await restarted.getByRole("button", { name: "Send ↗", exact: true }).click();
    await restarted.locator(".message.assistant").filter({ hasText: "Saved connection is working." }).waitFor();
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].authorization, "Bearer fixture-device-key-82743");
    assert.equal(JSON.stringify(provider.requests[0].body).includes("fixture-device-key-82743"), false);
    assert.equal((await restarted.content()).includes("fixture-device-key-82743"), false);
  } finally {
    await electron?.close();
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
});

async function verifyOtherWindowDenied(electron, url) {
  const opened = electron.waitForEvent("window", { timeout: 10000 });
  const id = await electron.evaluate(({ app, BrowserWindow }, url) => {
    const preload = `${app.getAppPath()}/dist/desktop/preload.cjs`;
    const other = new BrowserWindow({ show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true } });
    void other.loadURL(url);
    return other.id;
  }, url);
  try {
    const other = await opened;
    const result = await other.evaluate(() =>
      window.branchDesktop.modelSettings().then(() => "allowed", (error) => error.message));
    assert.match(result, /access denied/);
  } finally {
    await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
  }
}

test("native settings remain usable after a corrupt file or undecryptable key", {
  timeout: 90000,
}, async () => {
  const { home, options } = await desktopOptions();
  delete options.env.BRANCH_PROVIDER;
  const path = join(home, "model-settings.json");
  const cases = ["{broken", ...["http://127.0.0.1:1234/v1", "broken-url"].map(
    (endpoint) => JSON.stringify({ provider: "openai", endpoint,
      model: "fixture", encryptedKey: "aW52YWxpZA==" }),
  )];
  for (const content of cases) {
    await writeFile(path, content);
    const electron = await _electron.launch(options);
    try {
      const page = await electron.firstWindow();
      await page.getByText("Connected", { exact: true }).waitFor();
      await openSettingFor(page, "#model-provider");
      await page.locator("#model-settings-note").filter({ hasText: /could not/ }).waitFor();
      await page.getByLabel("Provider", { exact: true }).selectOption("demo");
      assert.equal(await page.locator("#model-settings-form").evaluate((form) => form.checkValidity()), true);
      await page.getByRole("button", { name: "Save model connection", exact: true }).click();
      await page.getByText("Connection saved. Quit from the tray and reopen Branch Agent to apply it.").waitFor();
      assert.equal(JSON.parse(await readFile(path, "utf8")).provider, "demo");
    } finally { await electron.close(); }
  }
});
