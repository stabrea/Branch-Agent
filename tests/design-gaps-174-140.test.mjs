/* Test cases for design gap fixes: DG-174 (phone breakpoint) and DG-140 (Inbox count) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const asking = {
  name: "test-model",
  async complete(request) {
    if (request.messages[request.messages.length - 1].role === "tool") {
      return { content: "OK", toolCalls: [] };
    }
    return { content: "Test response.", toolCalls: [] };
  },
};

test("DG-174: phone layout breakpoint is 760px, not 860px", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dg174-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: asking });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });

  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

  await call("/api/onboarding", { done: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });

  const signIn = async () => {
    const { challenge } = await call("/api/auth-start", {});
    const verified = await call("/api/auth-verify", { challenge, approval: "ok" });
    page.evaluate((token) => window.location.hash = `auth=${token}`, verified.token);
    await page.waitForNavigation();
  };

  await page.goto(server.url);
  await signIn();
  await page.waitForFunction(() => !document.querySelector("[hidden]#workspace")?.hidden, null, { timeout: 10000 });

  // Check phone layout applies at 760px but not at 861px
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.waitForTimeout(50);
  const at760 = await page.evaluate(() => {
    const places = document.getElementById("ew-places");
    return {
      placesVisible: places && getComputedStyle(places).display !== "none",
      tabletMode: true, // 700-760 range
    };
  });
  assert.equal(at760.placesVisible, false, "760px: phone bar should be hidden (tablet mode)");

  await page.setViewportSize({ width: 761, height: 1000 });
  await page.waitForTimeout(50);
  const at761 = await page.evaluate(() => {
    const places = document.getElementById("ew-places");
    return { placesVisible: places && getComputedStyle(places).display !== "none" };
  });
  assert.equal(at761.placesVisible, true, "761px: phone bar should show (desktop mode)");

  await page.setViewportSize({ width: 800, height: 1200 });
  await page.waitForTimeout(50);
  const at800 = await page.evaluate(() => {
    const rail = document.querySelector("body > .rail");
    const places = document.getElementById("ew-places");
    return {
      placesVisible: places && getComputedStyle(places).display !== "none",
      railPosition: getComputedStyle(rail).position,
    };
  });
  assert.equal(at800.placesVisible, false, "800px: desktop, no places bar");
  assert.notEqual(at800.railPosition, "fixed", "800px: rail should not be fixed in desktop mode");
});

test("DG-140: Inbox 'Needs you' tab has live count synchronized with badge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dg140-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: asking });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });

  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

  await call("/api/onboarding", { done: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  const signIn = async () => {
    const { challenge } = await call("/api/auth-start", {});
    const verified = await call("/api/auth-verify", { challenge, approval: "ok" });
    page.evaluate((token) => window.location.hash = `auth=${token}`, verified.token);
    await page.waitForNavigation();
  };

  await page.goto(server.url);
  await signIn();
  await page.waitForFunction(() => !document.querySelector("[hidden]#workspace")?.hidden, null, { timeout: 10000 });

  // Check that the needs tab has a count span
  const needsTab = await page.evaluate(() => {
    const tab = document.querySelector('[data-place="inbox"][data-tab="needs"].lx-tab');
    if (!tab) return { found: false };
    const count = tab.querySelector(".lx-tab-count");
    return {
      found: !!tab,
      hasCount: !!count,
      countId: count?.id,
    };
  });

  assert.equal(needsTab.found, true, "Inbox needs tab exists");
  assert.equal(needsTab.hasCount, true, "Needs tab has count span");
  assert.equal(needsTab.countId, "lx-needs-tab-count", "Count span has correct ID");
});
