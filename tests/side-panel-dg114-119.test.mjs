import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const tmp = await mkdtemp(join(tmpdir(), "branch-test-"));
const app = createBranch({ base: tmp });
const { close, server } = await startServer(app, { port: 0 });

test("DG-114-119: side panel structure and features", async (t) => {
  const data = server.url.origin;
  
  await t.test("DG-114: panel is titled via lx-pane-name", async () => {
    const html = await (await fetch(`${data}/`)).text();
    assert.match(html, /lx-pane-name/);
  });

  await t.test("DG-115: tabs exist with lx-pane-tab class", async () => {
    const html = await (await fetch(`${data}/`)).text();
    assert.match(html, /lx-pane-tab/);
  });

  await t.test("DG-116: footer checkbox for auto-open added", async () => {
    const html = await (await fetch(`${data}/`)).text();
    assert.match(html, /pane-foot/);
  });

  await t.test("DG-117: Terminal action localization string added", async () => {
    const locales = await (await fetch(`${data}/public/locales/en.json`)).json();
    assert.ok(locales["panels.terminal.open"] !== undefined);
  });

  await t.test("DG-118: close button class exists", async () => {
    const html = await (await fetch(`${data}/`)).text();
    assert.match(html, /lx-pane-close/);
  });

  await t.test("DG-119: context-block structure for empty sections", async () => {
    const html = await (await fetch(`${data}/`)).text();
    assert.match(html, /context-block/);
    assert.match(html, /context-rows/);
  });
});

await close();
