import test from "node:test";
import { openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { desktopOptions } from "./fixtures/desktop-options.mjs";

test("native identity settings survive restart and apply to a new task without exposing the local token", { timeout: 90000 }, async () => {
  const { options } = await desktopOptions();
  const first = await _electron.launch(options);
  try {
    const page = await first.firstWindow();
    await page.getByText("Connected", { exact: true }).waitFor();
    await openSettingFor(page, "#identity-name");
    await page.getByLabel("Assistant name", { exact: true }).fill("Native Juniper");
    await page.getByLabel("Working instructions", { exact: true }).fill("Keep checked results concise.");
    await page.getByRole("button", { name: "Save identity", exact: true }).click();
    await page.locator("#identity-status").filter({ hasText: "Identity saved." }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("branch-token")), null);
  } finally { await first.close(); }
  const second = await _electron.launch(options);
  try {
    const page = await second.firstWindow();
    await page.getByText("Connected", { exact: true }).waitFor();
    await openSettingFor(page, "#identity-name");
    assert.equal(await page.getByLabel("Assistant name", { exact: true }).inputValue(), "Native Juniper");
    assert.equal(await page.getByLabel("Working instructions", { exact: true }).inputValue(), "Keep checked results concise.");
    await page.locator(".lx-settings-close").click();
    await page.getByLabel("Your message", { exact: true }).fill("Run the file workflow.");
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
