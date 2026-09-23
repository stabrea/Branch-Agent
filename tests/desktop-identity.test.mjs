import test from "node:test";
import { openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { connected, desktopOptions } from "./fixtures/desktop-options.mjs";

/* Redesign phase 1: a conversation begun in the window starts on Ask first, and the practice run writes
   a file. This checks the desktop app, so its conversation follows the setting as before
   (tests/conversation-mode.test.mjs covers Ask first). */
const followSetting = (page) => page.evaluate(async () => {
  await fetch("/api/conversation-mode/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newConversation: "follow" }) });
  await globalThis.branchConversationMode?.refresh();
});

test("native identity settings survive restart and apply to a new task without exposing the local token", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions();
  const first = await _electron.launch(options);
  try {
    const page = await first.firstWindow();
    await connected(page);
    await openSettingFor(page, "#identity-name");
    await page.getByLabel("Assistant name", { exact: true }).fill("Native Juniper");
    await page.getByLabel("Working instructions", { exact: true }).fill("Keep checked results concise.");
    /* DG-025: kept when the field is left; wait for the save that carries both words. */
    const sent = page.waitForResponse((response) => response.url().endsWith("/api/identity") && response.request().method() === "POST"
      && response.request().postDataJSON().instructions === "Keep checked results concise.");
    await page.getByLabel("Working instructions", { exact: true }).blur();
    await sent;
    await page.locator("#identity-status").filter({ hasText: "Identity saved." }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("branch-token")), null);
  } finally { await first.close(); }
  const second = await _electron.launch(options);
  try {
    const page = await second.firstWindow();
    await connected(page);
    await openSettingFor(page, "#identity-name");
    assert.equal(await page.getByLabel("Assistant name", { exact: true }).inputValue(), "Native Juniper");
    assert.equal(await page.getByLabel("Working instructions", { exact: true }).inputValue(), "Keep checked results concise.");
    await page.locator(".lx-settings-close").click();
    await page.getByLabel("Your message", { exact: true }).fill("Run the file workflow.");
    await followSetting(page);
    await page.locator("#send").click();
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    const result = await page.evaluate(async () => {
      const state = await (await fetch("/api/state")).json();
      const run = state.runs.find(item => item.prompt === "Run the file workflow.");
      return (await fetch("/api/runs/" + run.id)).json();
    });
    assert.equal(result.run.status, "completed");
    assert.deepEqual(result.events.find(event => event.kind === "identity.applied").data, { name: "Native Juniper", revision: 1 });
  } finally { await second.close(); }
});
