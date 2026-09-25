/**
 * Wave 8: what a reply can show as well as say. A page or a drawing goes into a frame that is
 * sealed shut; a chart is drawn in the page with its numbers readable and saveable; a script is
 * never run by the frame but by `code.run`, behind the switch that guards it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-artifacts-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, errors };
}
/** Walks past the first-run panel so the conversation column is what is on screen. */
async function settle(page) {
  if (await page.locator("#first-run").isHidden()) return;
  /* "Try it without an account" finishes first run in one click. */
  await page.getByRole("button", { name: /Try it without an account/ }).click();
  await page.locator("#first-run").waitFor({ state: "hidden" });
}
/** A model that always answers with the same reply, so the card under test is predictable. */
const saying = (content) => ({ name: "scripted", async complete() { return { content, toolCalls: [] }; } });
const HTML_REPLY = "Here you go.\n\n```html\n<h1 id=\"made\">Hello</h1><script>parent.document.title='taken'</script>\n```";

test("W1 an html block becomes a card whose frame is sealed shut", async (t) => {
  const { page, errors } = await fixture(t, saying(HTML_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Draw me a page.");
  await page.locator("#send").click();
  const card = page.locator(".message.assistant .artifact").first();
  await card.waitFor();
  assert.match(await card.locator(".artifact-title").innerText(), /small page/i);

  const frame = card.locator("iframe.artifact-frame");
  await frame.waitFor();
  /* Empty sandbox: no scripts, no forms, and above all no shared origin with the page around it. */
  assert.equal(await frame.getAttribute("sandbox"), "", "the frame is not fully sandboxed");
  const source = await frame.getAttribute("src");
  assert.match(source, /^\/artifact\/[A-Za-z0-9_-]{32,48}$/, "the frame is not pointed at a minted address");
  assert.deepEqual(errors, []);
});

test("W1 the artifact page runs no script and cannot reach the page around it", async (t) => {
  const { page, server, errors } = await fixture(t, saying(HTML_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Draw me a page.");
  await page.locator("#send").click();
  const frame = page.locator("iframe.artifact-frame").first();
  await frame.waitFor();
  const source = await frame.getAttribute("src");

  /* The rules the page is served with are what stops a script; the sandbox is the second lock. */
  const served = await fetch(server.url + source);
  const policy = served.headers.get("content-security-policy") ?? "";
  assert.match(policy, /\bsandbox\b/, "the artifact is served without a sandbox");
  assert.equal(/allow-same-origin/.test(policy), false, "the artifact was given an origin it can share");
  assert.match(policy, /default-src 'none'/, "the artifact can still fetch things");
  const body = await served.text();
  assert.match(body, /Hello/, "the artifact's own words never arrived");
  assert.equal(/<script/i.test(body), false, "a script tag survived into the served page");

  /* The address is NOT used up by the first fetch: a frame that reloads must still work. */
  assert.equal((await fetch(server.url + source)).status, 200, "the artifact address died after one fetch");

  /* The script inside it did not reach out and rename this page. */
  await page.waitForTimeout(300);
  assert.equal(/taken/.test(await page.title()), false, "the artifact reached the page around it");
  assert.deepEqual(errors, []);
});

test("W1 a script block is not run by the frame but by code.run, behind its switch", async (t) => {
  const reply = "Try this.\n\n```javascript\nconsole.log(2 + 2);\n```";
  const { page, errors } = await fixture(t, saying(reply));
  await settle(page);
  await page.locator("#prompt").fill("Write me a script.");
  await page.locator("#send").click();
  const card = page.locator(".message.assistant .artifact").first();
  await card.waitFor();
  assert.equal(await card.locator("iframe").count(), 0, "a script was put in a frame");

  const calls = [];
  page.on("request", (request) => { if (request.url().includes("/api/tools/try")) calls.push(request.postData()); });
  await card.getByRole("button", { name: "Run this script", exact: true }).click();
  await page.locator(".artifact-output").waitFor();
  assert.equal(calls.length, 1, "the button did not go through the tool route");
  assert.match(calls[0], /"code\.run"/, "the button ran something other than code.run");
  /* Running small scripts is off until the owner turns it on, so this is what the owner sees. */
  assert.match(await card.locator(".artifact-output").innerText(), /switched off|Settings/i,
    "the switch that guards running a script was not the thing that answered");
  assert.deepEqual(errors, []);
});

const CHART_REPLY = 'Here are the figures.\n\n```chart\n{"type":"bar","title":"Cups by day",'
  + '"data":[{"label":"Mon","value":3},{"label":"Tue","value":7},{"label":"Wed","value":5}]}\n```';

test("W2 a chart block is drawn in the page, reads out under the pointer and shows its numbers", async (t) => {
  const { page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  /* The reply is shown at once and then drawn again when the saved conversation is loaded; a hover
     on the first drawing was read back from the second, empty one (CI, Windows, trunk 7c456c73).
     So the chart is used once the page says the run is finished. */
  await page.evaluate(() => {
    window.chartRunFinished = false;
    document.addEventListener("branch-run-finished", () => { window.chartRunFinished = true; }, { once: true });
  });
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await page.waitForFunction(() => window.chartRunFinished === true);
  const chart = page.locator(".message.assistant .chart").first();
  await chart.waitFor();
  assert.equal(await chart.locator("svg.chart-svg rect").count(), 4, "three bars and a background");

  /* The number under the pointer is written out in words, for anyone who cannot hover. Trigger and
     read it in one browser turn so a live conversation redraw cannot replace the chart between two
     Playwright packets on a busy runner. */
  const reading = await chart.evaluate((node) => {
    node.querySelectorAll("svg.chart-svg rect")[2]
      .dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    return node.querySelector(".chart-reading").textContent;
  });
  assert.equal(reading, "Tue: 7");

  /* The same numbers as a table, and back again. */
  assert.equal(await chart.locator(".md-table").isVisible(), false);
  await chart.getByRole("button", { name: "Show the numbers", exact: true }).click();
  await chart.locator(".md-table").waitFor();
  assert.deepEqual(await chart.locator(".md-table tbody td").allInnerTexts(), ["Mon", "3", "Tue", "7", "Wed", "5"]);
  await chart.getByRole("button", { name: "Show the chart only", exact: true }).click();
  assert.equal(await chart.locator(".md-table").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("W2 the chart is saved as a picture by the page itself, with nothing drawn on the server", async (t) => {
  const { page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await page.locator(".chart-svg").first().waitFor();
  /* A canvas that has been handed anything from somewhere else refuses to give its picture back,
     so this asserts the real thing: a PNG comes out, which proves the drawing never tainted it. */
  const png = await page.evaluate(async () => {
    const { chartPng } = await import("/charts.js");
    return chartPng(document.querySelector("svg.chart-svg"));
  });
  assert.match(png, /^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/, "no picture came back from the canvas");
  assert.deepEqual(errors, []);
});

test("W2 a chart block that says nothing usable is refused in words, not half-drawn", async (t) => {
  const { page, errors } = await fixture(t, saying("```chart\n{\"type\":\"bar\",\"data\":[]}\n```"));
  await settle(page);
  await page.locator("#prompt").fill("Chart nothing.");
  await page.locator("#send").click();
  const card = page.locator(".message.assistant .artifact").first();
  await card.waitFor();
  assert.match(await card.locator(".artifact-note").innerText(), /no numbers to draw/i);
  assert.equal(await card.locator("svg.chart-svg").count(), 0, "an empty chart was drawn anyway");
  assert.deepEqual(errors, []);
});

test("W1 Save to workspace keeps the artifact beside its task, where Documents lists it", async (t) => {
  const { app, page, errors } = await fixture(t, saying(HTML_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Draw me a page.");
  await page.locator("#send").click();
  const card = page.locator(".message.assistant .artifact").first();
  await card.waitFor();
  await card.getByRole("button", { name: "Save to workspace", exact: true }).click();
  await page.waitForFunction(() => /Saved as/.test(document.querySelector(".artifact-note")?.textContent ?? ""));

  const kept = await app.artifacts.list(20);
  const mine = kept.find((entry) => entry.name.startsWith("artifact-") && entry.name.endsWith(".html"));
  assert.ok(mine, "nothing was kept beside the task");
  assert.equal(mine.mediaType, "text/html");
  assert.deepEqual(errors, []);
});

/* Wave 8 (A1940): one message can be put to a specialist, and the reply says which one answered. */
test("W3 a message put to a specialist comes back signed with that specialist's name", async (t) => {
  const asked = [];
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete(request) {
      asked.push((request?.messages ?? []).map((message) => String(message?.content ?? "")).join("\n"));
      return { content: "The invoices are filed.", toolCalls: [] };
    },
  });
  await settle(page);
  /* A specialist the owner has already switched on, so the composer can offer it. */
  app.store.save("specialists", app.runtime.owner, "b1a7d1e2-0000-4000-8000-000000000001",
    { definition: { name: "The bookkeeper", purpose: "Files invoices.", instructions: "File invoices.", permissions: ["files.read"] },
      activeVersion: 1, status: "active", versions: [] });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  await page.waitForFunction(() => document.getElementById("composer-specialist").options.length > 1);
  /* The calm window keeps the picker under More; choosing there chooses the real one. */
  await page.locator("#lx-more").click();
  await page.locator("#lx-more-assistant").selectOption({ label: "The bookkeeper" });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#composer-specialist").inputValue() !== "", true, "the real picker follows");

  await page.locator("#prompt").fill("File yesterday's invoices.");
  await page.locator("#send").click();
  await page.locator(".message.assistant").last().waitFor({ timeout: 30000 });

  /* The stylesheet shouts the author line, so the comparison is on the words, not their case. */
  const author = await page.locator(".message.assistant small").last().innerText();
  assert.equal(author.toLowerCase(), "the bookkeeper", "the reply was not signed by the specialist that answered");
  /* What the owner typed is what they see; the delegation wrapper is not shown back to them. */
  assert.match(await page.locator(".message.user").last().innerText(), /^File yesterday's invoices./);
  assert.equal(/Delegate to specialist/.test(await page.locator(".message.user").last().innerText()), false,
    "the owner was shown the machinery instead of what they typed");
  assert.ok(asked.some((text) => /Delegate to specialist b1a7d1e2/.test(text)),
    "the message never actually went to the specialist");
  assert.deepEqual(errors, []);
});

test("W1 an artifact card fits a 400 pixel window without scrolling sideways", async (t) => {
  const { page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await page.locator(".chart-svg").first().waitFor();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(sideways <= 1, `the page scrolls sideways by ${sideways}px`);
  const column = await page.evaluate(() => {
    const workspace = document.getElementById("workspace");
    return workspace.scrollWidth - workspace.clientWidth;
  });
  assert.ok(column <= 1, `the reading column scrolls sideways by ${column}px`);
  assert.deepEqual(errors, []);
});
