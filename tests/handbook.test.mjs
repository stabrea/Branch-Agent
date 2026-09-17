/**
 * The owner's handbook: that every chapter exists and opens the way a chapter should, that the
 * links between them resolve, that the reference names every setting, that the app serves each
 * chapter to itself, and that Help opens the right chapter for the section a person is looking at.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { helpChapters, chapterForView } from "../dist/help.js";

const ROOT = join(import.meta.dirname, "..");
const HANDBOOK = join(ROOT, "docs", "handbook");

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-handbook-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
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
  return { app, page, server, errors };
}

/** Walks past the first-run panel, when there is one, so a section can be opened. */
async function settle(page) {
  if (await page.locator("#first-run").isHidden()) return;
  await page.getByRole("button", { name: /Just look around/ }).click();
  await page.getByRole("button", { name: "Done, start chatting", exact: true }).click();
  await page.locator("#first-run").waitFor({ state: "hidden" });
}

test("H1 every chapter exists and opens with the two headings a chapter must have", async () => {
  const files = (await readdir(HANDBOOK)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(files, helpChapters.map((chapter) => `${chapter.id}.md`));
  for (const chapter of helpChapters) {
    // Git hands these files back with Windows line endings on this computer, so the headings are
    // looked for in text whose line endings have been made the same either way.
    const text = (await readFile(join(HANDBOOK, `${chapter.id}.md`), "utf8")).replace(/\r\n/g, "\n");
    assert.match(text, /^# .+/, `${chapter.id} has no title`);
    assert.ok(text.includes("\n## What this is for\n"), `${chapter.id} never says what it is for`);
    assert.ok(text.includes("\n## In one minute\n"), `${chapter.id} has no "In one minute"`);
    assert.ok(text.split(/\s+/).length > 250, `${chapter.id} is too short to be a chapter`);
  }
});

test("H1 no chapter carries a wave number, a batch number or an audit id", async () => {
  for (const chapter of helpChapters) {
    // Git hands these files back with Windows line endings on this computer, so the headings are
    // looked for in text whose line endings have been made the same either way.
    const text = (await readFile(join(HANDBOOK, `${chapter.id}.md`), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(/\b(?:wave|batch)\s*\d+\b/i.test(text), false, `${chapter.id} mentions a wave or batch`);
    assert.equal(/\bA\d{4}\b/.test(text), false, `${chapter.id} carries an audit id`);
  }
});

test("H2 the document checker passes: every setting is in the reference and every link resolves", () => {
  const done = spawnSync(process.execPath, [join(ROOT, "scripts", "check-docs.mjs")], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(done.status, 0, `check-docs.mjs failed:\n${done.stdout}\n${done.stderr}`);
  assert.match(done.stdout, /every handbook link resolves/);
});

test("H3 the README front page links every chapter and keeps the notices", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  for (const chapter of helpChapters)
    assert.ok(readme.includes(`docs/handbook/${chapter.id}.md`), `README never links ${chapter.id}`);
  assert.ok(readme.includes("THIRD_PARTY_NOTICES.md"), "README dropped the third-party notices");
  assert.ok(readme.includes("docs/images/conversation.png"), "README has no screenshot");
});

test("H4 the app serves every chapter, and refuses anything else", async (t) => {
  const { server } = await fixture(t);
  const ask = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } });

  const listed = await (await ask("/api/help")).json();
  assert.equal(listed.chapters.length, helpChapters.length);

  for (const chapter of helpChapters) {
    const answer = await ask(`/api/help/${chapter.id}`);
    assert.equal(answer.status, 200, `${chapter.id} was not served`);
    const body = await answer.json();
    assert.equal(body.id, chapter.id);
    assert.equal(body.title, chapter.title);
    assert.ok(body.markdown.includes("## What this is for"), `${chapter.id} came back without its opening`);
  }

  assert.equal((await ask("/api/help/nonsense")).status, 404);
  assert.equal((await ask("/api/help/../../package.json")).status, 404);
});

test("H4 the help route needs the session key like every other route", async (t) => {
  const { server } = await fixture(t);
  const answer = await fetch(new URL("/api/help/09-glossary", server.url));
  assert.equal(answer.status, 401);
});

test("H4 Help opens the chapter for the section you are on", async (t) => {
  const { page, errors } = await fixture(t);
  await settle(page);

  /* Documents is answered by "Everyday tasks", which is what the owner menu should open there. */
  assert.equal(chapterForView("documents").id, "02-everyday-tasks");
  await page.locator('.nav[data-view="documents"]').first().click();
  await page.locator("#owner-menu-button").click();
  await page.locator("#menu-help").click();
  await page.locator("#context-help").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("context-help").dataset.chapter);

  assert.equal(await page.locator("#context-help").getAttribute("data-chapter"), "02-everyday-tasks");
  assert.equal(await page.locator("#context-help-title").textContent(), "Everyday tasks");
  const shown = await page.locator("#context-help-body").innerText();
  assert.ok(shown.includes("What this is for"), "the chapter was not rendered");
  /* Rendered through the same Markdown renderer every reply uses, so headings are real headings. */
  assert.ok(await page.locator("#context-help-body h2").count() > 1);

  await page.locator("#context-help-close").click();
  await page.locator("#context-help").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("H4 the palette offers every chapter by name", async (t) => {
  const { page, errors } = await fixture(t);
  await settle(page);
  await page.keyboard.press("Control+k");
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  await page.locator("#cmd-input").fill("Help: Glossary");
  const entry = page.locator(".cmd-item", { hasText: "Help: Glossary" }).first();
  await entry.waitFor({ state: "visible" });
  await entry.click();
  await page.locator("#context-help").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("context-help").dataset.chapter === "09-glossary");
  assert.deepEqual(errors, []);
});

test("H5 the release-notes drafter reads the checkpoint and writes the plain structure", async () => {
  const done = spawnSync(process.execPath, [join(ROOT, "scripts", "release-notes.mjs"), "--since", "v0.14.0"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (done.status !== 0 && /Could not read|No tag/.test(done.stderr)) return; /* a shallow checkout has no tags */
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^## What changed in/);
  assert.match(done.stdout, /\*\*Install\*\*/);
  assert.equal(/\b(?:wave|batch)\s*\d+\b/i.test(done.stdout), false, "the draft leaked a wave or batch number");
  assert.equal(/\bA\d{4}\b/.test(done.stdout), false, "the draft leaked an audit id");
});

test("H5 the template says what shape the notes take", async () => {
  const text = await readFile(join(ROOT, "docs", "release-notes-template.md"), "utf8");
  assert.ok(text.includes("## What changed in X.Y.Z"));
  assert.ok(text.includes("scripts/release-notes.mjs"));
});
