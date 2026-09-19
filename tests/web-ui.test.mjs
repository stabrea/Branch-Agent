/**
 * Wave 6: the web app's own screens. Markdown that is rendered and never trusted, the "Look inside"
 * panel, stepping into a task while it works, the context meter, the developer playground, the
 * installable-app files, and switching the language.
 */
import test from "node:test";
import { openPlace, openSettingFor, showEverything } from "./places.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "markdown-sample.md");

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-web-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  /* This file exercises the full window's own controls: "Show everything" since 0.18.1. */
  await showEverything(page);
  return { app, page, server, errors, browser };
}
/** Walks past the first-run panel, when there is one, so the conversation column is what is on screen. */
async function settle(page) {
  if (await page.locator("#first-run").isHidden()) return;
  /* "Try it without an account" finishes first run in one click. */
  await page.getByRole("button", { name: /Try it without an account/ }).click();
  await page.locator("#first-run").waitFor({ state: "hidden" });
}

test("U1 the markdown fixture renders its real structure and never becomes markup", async (t) => {
  const { page, errors } = await fixture(t);
  const source = await readFile(FIXTURE, "utf8");
  const shape = await page.evaluate(async (markdown) => {
    const { renderMarkdown } = await import("/markdown.js");
    const host = document.createElement("div");
    host.className = "markdown";
    host.append(renderMarkdown(markdown));
    document.body.append(host);
    const code = host.querySelector(".code-block");
    return {
      headings: [...host.querySelectorAll("h1,h2,h3")].map((n) => n.textContent),
      listItems: [...host.querySelectorAll("ul.md-list li")].map((n) => n.textContent),
      ordered: host.querySelectorAll("ol.md-list li").length,
      tableHeads: [...host.querySelectorAll(".md-table th")].map((n) => n.textContent),
      tableCells: host.querySelectorAll(".md-table td").length,
      link: host.querySelector("a")?.getAttribute("href") ?? null,
      linkTarget: host.querySelector("a")?.getAttribute("target") ?? null,
      inlineCode: [...host.querySelectorAll("p code")].map((n) => n.textContent),
      language: code?.querySelector(".code-language")?.textContent ?? null,
      copyLabel: code?.querySelector(".code-copy")?.textContent ?? null,
      codeText: code?.querySelector("pre code")?.textContent ?? null,
      quote: host.querySelector("blockquote")?.textContent ?? null,
      /* Nothing in the source may have become a real element or a live handler. */
      scripts: host.querySelectorAll("script").length,
      images: host.querySelectorAll("img").length,
      rawTextHasTag: host.textContent.includes("<script>"),
      javascriptLinks: [...host.querySelectorAll("a")].filter((a) => a.href.startsWith("javascript:")).length,
    };
  }, source);
  assert.deepEqual(shape.headings, ["A sample document", "What it covers", "One more level"]);
  assert.deepEqual(shape.listItems, ["a plain bullet", "a bullet with bold inside", "a bullet with code inside"]);
  assert.equal(shape.ordered, 2, "the numbered list rendered");
  assert.deepEqual(shape.tableHeads, ["Thing", "What it does"]);
  assert.equal(shape.tableCells, 4);
  assert.equal(shape.link, "https://example.com/docs");
  assert.equal(shape.linkTarget, "_blank", "links open outside the app");
  assert.ok(shape.inlineCode.includes("branch start"), "inline code became a code element");
  assert.equal(shape.language, "javascript", "the fence's language is written out");
  assert.equal(shape.copyLabel, "Copy");
  assert.match(shape.codeText, /const answer = 42;/);
  assert.match(shape.quote, /quoted line/);
  assert.equal(shape.scripts, 0, "a script tag in the source is never a script tag on the page");
  assert.equal(shape.images, 0, "an onerror image in the source is never an image on the page");
  assert.equal(shape.javascriptLinks, 0, "a javascript: link is never followable");
  assert.ok(shape.rawTextHasTag, "the tag survives as visible text, which is the point");
  assert.deepEqual(errors, []);
});

test("U1 a reply written in markdown is rendered in the conversation, not shown raw", async (t) => {
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "# Heading\n\nSome **bold** words.\n\n```js\nlet x = 1;\n```", toolCalls: [] }; },
  });
  await settle(page);
  await page.locator("#prompt").fill("Say something in markdown.");
  await page.locator("#send").click();
  await page.locator(".message.assistant .markdown").waitFor();
  assert.equal(await page.locator(".message.assistant .markdown h1").innerText(), "Heading");
  assert.equal(await page.locator(".message.assistant .markdown strong").innerText(), "bold");
  /* The label is written out in the markup; the stylesheet is what shouts it. */
  assert.equal(await page.locator(".message.assistant .code-language").textContent(), "js");
  assert.deepEqual(errors, []);
});

test("U1 a saved note keeps its inline formatting and still cannot carry markup", async (t) => {
  const { page, errors } = await fixture(t);
  await settle(page);
  await openPlace(page, "memory");
  await page.getByLabel("Remember something").fill("Prefer **short** answers and `npm start`, never <script>alert(1)</script>.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  const card = page.locator("#memory-list article h3").first();
  await card.waitFor();
  assert.equal(await card.locator("strong").innerText(), "short", "bold became a real element");
  assert.equal(await card.locator("code").innerText(), "npm start", "inline code became a real element");
  assert.equal(await card.locator("script").count(), 0, "a script tag in a saved note is never a script tag");
  assert.match(await card.innerText(), /<script>/, "it survives as visible text instead");
  assert.deepEqual(errors, []);
});

test("U2 Look inside shows a scripted task's tool rows and saves as JSON", async (t) => {
  let asked = 0;
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete() {
      asked += 1;
      return asked === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) }] }
        : { content: "Written.", toolCalls: [] };
    },
  });
  await settle(page);
  await page.locator("#prompt").fill("Write a note.");
  await page.locator("#send").click();
  await page.locator(".message.assistant").waitFor();
  /* The route answers whatever the panel will draw, so check it directly as well as on screen. */
  const runId = app.store.runs(app.runtime.owner).at(0).id;
  await openPlace(page, "runs");
  await page.locator("#runs-list").getByRole("button", { name: "Look inside" }).first().click();
  await page.locator("#inspect-panel").waitFor({ state: "visible" });
  await page.locator(".inspect-call").first().waitFor();
  const names = await page.locator(".inspect-call summary strong").allInnerTexts();
  assert.ok(names.includes("files.write"), `the tool it used is listed: ${names.join(", ")}`);
  const headings = await page.locator(".inspect-section h3").evaluateAll((nodes) => nodes.map((n) => n.textContent));
  for (const heading of ["Times it asked the model", "Tools it used", "Step by step"])
    assert.ok(headings.includes(heading), `${heading} is one of the sections`);
  /* The round rows must carry real numbers, not just the model's name and a duration. */
  const roundLine = await page.locator(".inspect-section").filter({ hasText: /Times it asked the model/i }).locator(".inspect-row .meta").first().innerText();
  assert.match(roundLine, /\d[\d,]*\s+words of prompt/, `the prompt size is shown: ${roundLine}`);
  assert.match(roundLine, /\d[\d,]*\s+in, \d[\d,]*\s+out/, `the tokens are shown: ${roundLine}`);
  assert.match(roundLine, /counted by the provider|our own estimate/, `where the numbers came from is said: ${roundLine}`);
  /* Opening a tool row must show what it was actually given and what actually came back. */
  const call = page.locator(".inspect-call").filter({ has: page.locator("summary strong", { hasText: "files.write" }) }).first();
  await call.locator("summary").click();
  const opened = await call.innerText();
  assert.match(opened, /note\.txt/, `the arguments it was given are shown: ${opened}`);
  assert.match(opened, /GIVEN|Given/, "the input is labelled");
  assert.match(opened, /CAME BACK|Came back/, "the output is labelled");
  /* And the same numbers have to be in the saved file, not only on the screen. */
  const view = await page.evaluate(async (id) =>
    (await fetch(`/api/runs/${id}/inspect`, { headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json(), runId);
  assert.ok(view.rounds.length >= 1, "the answer carries the model rounds");
  assert.ok(view.rounds.every((r) => typeof r.tokens.input === "number" && r.promptTokens !== null), `every round is counted: ${JSON.stringify(view.rounds)}`);
  assert.ok(view.rounds.every((r) => r.cost && "display" in r.cost), "every round is priced, or says there is no price");
  const written = view.calls.find((c) => c.name === "files.write");
  assert.ok(written?.input?.includes("note.txt"), `the call's input is kept: ${written?.input}`);
  assert.ok(written?.output, "the call's output is kept");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save this as a file" }).click();
  const saved = await download;
  assert.match(saved.suggestedFilename(), new RegExp(`branch-task-${runId}\\.json`));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.ok(await page.locator("#inspect-panel").isHidden());
  assert.deepEqual(errors, []);
});

test("U3 the live row appears during a slow task and Stop cancels it", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete(_request, options) {
      /* Hold the first answer open long enough to see the row and press Stop. */
      await Promise.race([held, new Promise((r) => setTimeout(r, 15000))]);
      options?.signal?.throwIfAborted?.();
      return { content: "Finished.", toolCalls: [] };
    },
  });
  await settle(page);
  await page.locator("#prompt").fill("Take your time.");
  await page.locator("#send").click();
  await page.locator("#live-row").waitFor({ state: "visible" });
  await page.locator("#live-stop").waitFor();
  assert.match(await page.locator("#live-line").innerText(), /s so far|Working/);
  for (const id of ["live-pause", "live-steer", "live-stop"])
    assert.ok(await page.locator("#" + id).isVisible(), `${id} is offered`);
  /* Asking it to wait and telling it to carry on are both notes to a working task, and both must
     come back without an error; neither may touch the resume route, which refuses a running task. */
  await page.locator("#live-pause").click();
  await page.locator("#live-status").filter({ hasText: /Told to wait/ }).waitFor();
  assert.equal(await page.locator("#live-pause").innerText(), "Tell it to carry on");
  await page.locator("#live-pause").click();
  await page.locator("#live-status").filter({ hasText: /picks up where it left off/ }).waitFor();
  assert.equal(await page.locator("#live-pause").innerText(), "Ask it to wait");
  /* Telling it something mid-task lands on the steer route too. */
  await page.locator("#live-steer").click();
  await page.locator("#live-steer-text").fill("Keep it short.");
  await page.locator("#live-steer-send").click();
  await page.locator("#live-status").filter({ hasText: /take that into account/ }).waitFor();
  await page.locator("#live-stop").click();
  await page.locator("#live-status").filter({ hasText: "Stopped." }).waitFor();
  release();
  await page.waitForTimeout(500);
  assert.deepEqual(errors, []);
});

test("U3 an approval question appears in the conversation and the answer reaches the policy route", async (t) => {
  let asked = 0;
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete() {
      asked += 1;
      return asked === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "gated.txt", content: "x" }) }] }
        : { content: "Done.", toolCalls: [] };
    },
  });
  /* Ask before anything that changes something, so the write below has to stop and ask. */
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await settle(page);
  await page.locator("#prompt").fill("Write a gated file.");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await page.locator("#live-ask p").innerText(), /Before I go ahead/);
  for (const label of ["Yes, just now", "Yes, for this conversation", "Yes, always", "No"])
    assert.ok(await page.locator("#live-ask").getByRole("button", { name: label, exact: true }).isVisible(), `${label} is offered`);
  await page.locator("#live-ask").getByRole("button", { name: "Yes, always", exact: true }).click();
  await page.locator("#live-ask .meta").waitFor();
  /* "Always" is written into the policy, which is how we know the answer reached the route. */
  const rules = app.store.get("settings", app.runtime.owner, "policy")?.data?.rules ?? [];
  assert.ok(rules.some((rule) => rule.tool === "files.write" && rule.decision === "allow"), `the yes was remembered: ${JSON.stringify(rules)}`);
  assert.deepEqual(errors, []);
});

test("U4 the context meter fills in after a task and opens its numbers", async (t) => {
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "A short answer.", toolCalls: [] }; },
  });
  await settle(page);
  await page.locator("#prompt").fill("Hello there.");
  await page.locator("#send").click();
  await page.locator(".message.assistant").waitFor();
  await page.locator("#meter-row").waitFor({ state: "visible" });
  await page.waitForFunction(() => Number(document.getElementById("meter-row").dataset.share) >= 0 && document.getElementById("meter-text").textContent.length > 0);
  assert.match(await page.locator("#meter-text").innerText(), /words of context/);
  assert.match(await page.evaluate(() => document.getElementById("meter-cost").textContent), /so far|^$/, "a price shows only when one is known");
  await page.locator("#meter-button").click();
  await page.locator("#meter-popover").waitFor({ state: "visible" });
  const rows = await page.locator(".meter-stat").allInnerTexts();
  assert.ok(rows.some((row) => row.startsWith("Words in")), `the numbers are behind the bar: ${rows.join(" | ")}`);
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#meter-popover").isHidden());
  assert.deepEqual(errors, []);
});

test("U5 the playground runs a read-only tool and shows what came back", async (t) => {
  const { page, errors } = await fixture(t);
  await settle(page);
  await openSettingFor(page, "#playground");
  await page.locator("#playground summary").click();
  await page.waitForFunction(() => document.getElementById("play-tool").options.length > 1);
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("playground.txt");
  await page.locator("#play-field-content").fill("written by hand");
  await page.getByRole("button", { name: "Run it", exact: true }).click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /playground\.txt/);
  await page.locator("#play-tool").selectOption("files.read");
  await page.locator("#play-field-path").fill("playground.txt");
  await page.getByRole("button", { name: "Run it", exact: true }).click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /written by hand/);
  assert.deepEqual(errors, []);
});

test("U5 a tool the settings say to ask about stops and asks before it runs", async (t) => {
  const { app, page } = await fixture(t);
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await settle(page);
  await openSettingFor(page, "#playground");
  await page.locator("#playground summary").click();
  await page.waitForFunction(() => document.getElementById("play-tool").options.length > 1);
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("asked.txt");
  await page.locator("#play-field-content").fill("only after a yes");
  await page.getByRole("button", { name: "Run it", exact: true }).click();
  await page.locator("#play-confirm").waitFor();
  assert.match(await page.locator("#play-result").innerText(), /needs your say-so/);
  const before = await app.registry.execute("files.list", { path: "." }, app.runtime.context()).catch(() => ({ entries: [] }));
  assert.ok(!JSON.stringify(before).includes("asked.txt"), "nothing was written before the yes");
  await page.locator("#play-confirm").click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /asked\.txt/);
});

test("U6 the installable-app files are served and the worker is skipped inside the desktop app", async (t) => {
  const { page, server, browser } = await fixture(t);
  for (const [path, type] of [
    ["/manifest.webmanifest", /application\/manifest\+json/],
    ["/service-worker.js", /text\/javascript/],
    ["/assets/icon-192.png", /image\/png/],
    ["/assets/icon-512.png", /image\/png/],
    ["/assets/icon.svg", /image\/svg/],
  ]) {
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    assert.equal(response.status, 200, `${path} is served`);
    assert.match(response.headers.get("content-type") ?? "", type, `${path} is served as the right kind of file`);
  }
  const manifest = await (await fetch(server.url + "/manifest.webmanifest", { headers: { origin: server.url } })).json();
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 3);
  /* The page in a browser registers a worker; the same page inside the desktop app does not. */
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller) || navigator.serviceWorker.getRegistrations().then((r) => r.length > 0));
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  assert.ok(registrations > 0, "the browser keeps the app's files");
  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => desktopPage.close());
  const workerRequests = [];
  desktopPage.on("request", (request) => { if (request.url().endsWith("/service-worker.js")) workerRequests.push(request.url()); });
  await desktopPage.goto(server.url + "/?desktop=1");
  await desktopPage.getByLabel("Session token", { exact: true }).fill(server.token);
  await desktopPage.getByRole("button", { name: "Connect", exact: true }).click();
  await desktopPage.locator("#workspace").waitFor({ state: "visible" });
  await desktopPage.waitForTimeout(600);
  const scope = new URL(server.url).origin + "/";
  /* Sharing an origin means the earlier page's worker is visible here too, so what proves the skip
     is that this page never asked for the file, and never offers to install itself. */
  assert.deepEqual(workerRequests, [], "the desktop app never registers a worker of its own");
  assert.equal(await desktopPage.locator("#install-app").count(), 0, "the desktop app never offers to install itself");
  assert.ok(scope.endsWith("/"));
});

test("U6 the offline banner says plainly that nothing new can happen", async (t) => {
  const { page } = await fixture(t);
  await settle(page);
  assert.ok(await page.locator("#offline-banner").isHidden(), "nothing is said while the computer answers");
  await page.context().setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event("offline")));
  await page.locator("#offline-banner").waitFor({ state: "visible" });
  assert.match(await page.locator("#offline-banner").innerText(), /cannot do anything new/);
  await page.context().setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await page.locator("#offline-banner").waitFor({ state: "hidden" });
});

test("U6 the shell fits a 400 pixel window with the new rows on screen", async (t) => {
  const { page } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "Short.", toolCalls: [] }; },
  });
  await settle(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.locator("#prompt").fill("Hello.");
  await page.locator("#send").click();
  await page.locator(".message.assistant").waitFor();
  await page.locator("#meter-row").waitFor({ state: "visible" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no sideways scrolling at 400 px (overflow ${overflow})`);
});

test("U7 switching the language changes a visible label and English stays the fallback", async (t) => {
  const { page, server, errors } = await fixture(t);
  for (const path of ["/locales/en.json", "/locales/fr.json"]) {
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    assert.equal(response.status, 200, `${path} is served`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  }
  const [english, french] = await Promise.all(
    ["/locales/en.json", "/locales/fr.json"].map((p) => fetch(server.url + p, { headers: { origin: server.url } }).then((r) => r.json())),
  );
  const missing = Object.keys(english).filter((key) => !(key in french));
  assert.deepEqual(missing, [], "the second language answers every key English does");
  await settle(page);
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Memory");
  await openSettingFor(page, "#appearance-language");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.getElementById("appearance-language").value === "fr" && document.documentElement.lang === "fr");
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Mémoire");
  assert.equal(await page.locator('.lx-place-link[data-place="library"]').innerText(), "Bibliothèque");
  assert.equal(await page.locator('.lx-settings-link[data-page="data"]').innerText(), "Données et consommation");
  /* A key with no French on file falls back to English rather than showing a blank. */
  const fallback = await page.evaluate(async () => {
    const { t } = await import("/i18n.js");
    return t("nav.chat");
  });
  assert.equal(fallback, "Conversation");
  await page.locator("#appearance-language").selectOption("en");
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Memory");
  assert.deepEqual(errors, []);
});

test("U7 dates and numbers follow the chosen language", async (t) => {
  const { page } = await fixture(t);
  const shown = await page.evaluate(async () => {
    const { formatNumber, formatDate, setLanguage } = await import("/i18n.js");
    await setLanguage("fr");
    const french = { number: formatNumber(1234567), date: formatDate("2026-03-04T09:05:00Z", { dateStyle: "long" }) };
    await setLanguage("en");
    return { french, english: { number: formatNumber(1234567), date: formatDate("2026-03-04T09:05:00Z", { dateStyle: "long" }) } };
  });
  assert.notEqual(shown.french.number, shown.english.number, "1234567 is not written the same way in both");
  assert.notEqual(shown.french.date, shown.english.date, "the date is not written the same way in both");
});

/* ==================== Wave 8: the design QA pass ====================
   Q2 a colour is written down in exactly one file; Q6 every section intro and card title has a key,
   and every language file answers it. These read the source, so they need no browser. */

const PUBLIC = join(import.meta.dirname, "..", "public");

test("Q2 no stylesheet but the token layer writes a colour down", async (t) => {
  const sheets = (await readdir(PUBLIC)).filter((name) => name.endsWith(".css") && name !== "tokens.css");
  assert.ok(sheets.length >= 3, "the stylesheets moved; this test is looking in the wrong place");
  const offenders = [];
  for (const name of sheets) {
    const text = await readFile(join(PUBLIC, name), "utf8");
    text.split("\n").forEach((line, index) => {
      /* A comment may name a colour; a rule may not. */
      const rule = line.replace(/\/\*.*?\*\//g, "").split("/*")[0];
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/.test(rule))
        offenders.push(`${name}:${index + 1} ${rule.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], "every colour belongs in public/tokens.css");
});

test("Q6 the page never shows a key where a word should be", async (t) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const keys = [...new Set([...html.matchAll(/data-t(?:-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 60, "the markup carries fewer keys than the sections need");
  assert.deepEqual(keys.filter((key) => !(key in english)), [], "a key in the markup has no English words");

  /* Every other language answers the same keys, so nothing falls through to a raw key. */
  for (const file of (await readdir(join(PUBLIC, "locales"))).filter((n) => n !== "en.json")) {
    const other = JSON.parse(await readFile(join(PUBLIC, "locales", file), "utf8"));
    const missing = Object.keys(english).filter((key) => !(key in other));
    assert.deepEqual(missing, [], `${file} does not answer every key English does`);
  }
});

test("Q6 each of the ten sections has its own words on file", async (t) => {
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  for (const view of ["runs", "usage", "memory", "skills", "specialists", "procedures", "schedules", "documents", "settings"]) {
    const mine = Object.keys(english).filter((key) => key.startsWith(`${view}.`));
    assert.ok(mine.length > 0, `${view} has no words of its own behind a key`);
  }
});

/* Wave 8: the coverage test is tightened. It used to ask only that every key in the markup had
   English words; now it asks the other way round — that no button, field label or tick box on the
   page says anything that is not behind a key, so switching the language leaves nothing in English. */
test("Q6 every button and field label on the page says its words through a key", async (t) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const nameless = [];
  /* A button or label whose whole content is plain words must carry the key for those words. */
  for (const [whole, attributes, text] of html.matchAll(/<(?:button|label)\b([^>]*)>([^<]{1,200})<\/(?:button|label)>/g))
    if (!/\bdata-t[=\s]/.test(attributes) && text.trim()) nameless.push(text.trim().slice(0, 60));
  /* A tick box carries its words after the input; they belong in a span with a key of their own. */
  for (const [, attributes, , text] of html.matchAll(/<label\b([^>]*)>(<input[^>]*?\/?>)\s*([^<]{2,200})<\/label>/g))
    if (!/\bdata-t[=\s]/.test(attributes) && text?.trim()) nameless.push(text.trim().slice(0, 60));
  assert.deepEqual(nameless, [], "these controls still say their words in English only");

  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  assert.ok(Object.keys(english).filter((key) => key.startsWith("action.")).length > 80,
    "the buttons on the page are not all behind keys");
  assert.ok(Object.keys(english).filter((key) => key.startsWith("field.")).length > 80,
    "the field labels on the page are not all behind keys");
});

/* Words that are genuinely the same in both languages — proper names, and words French borrowed
   whole. Anything else left in English is a translation that was never written. */
const SHARED_WITH_FRENCH = new Set([
  "Conversation", "Conversations", "Documents", "Messages", "Gemini", "Secrets", "Diagnostics",
  // The password managers are called what their makers call them, in either language.
  "1Password", "Bitwarden",
]);
test("Q6 French is a real translation, not the English file under another name", async (t) => {
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const french = JSON.parse(await readFile(join(PUBLIC, "locales", "fr.json"), "utf8"));
  // A string that is only a place for words said elsewhere ("{message}") has nothing to translate.
  const wordless = (text) => !/\p{L}/u.test(text.replace(/\{[^}]+\}/g, ""));
  const copied = Object.keys(english).filter((key) =>
    french[key] === english[key] && !SHARED_WITH_FRENCH.has(english[key]) && !wordless(english[key]));
  assert.deepEqual(copied, [], "these keys still answer in English when French is chosen");
  assert.ok(Object.keys(french).length >= Object.keys(english).length, "French answers every key");
});
