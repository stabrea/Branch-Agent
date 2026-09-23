/* Git activity, under Schedules (public/collab-git.js): the owner reads a repository's live status
   with a click, publishes it as a signed patch, and finds it again by searching, all from the
   window — not only through the API the earlier tests already cover (tests/collab-git-events.test.mjs,
   tests/collab-git-status.test.mjs). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { GitRunner, locateGit } from "../dist/integrations/git-run.js";

const installed = await locateGit();
const needsGit = { skip: installed ? false : "Git is not installed on this computer" };
const shots = process.env.BRANCH_TEST_SHOTS;

test("the owner reads a repository's status, publishes a patch, and finds it by searching", needsGit, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-collab-git-panel-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });

  const owner = app.runtime.owner;
  const folder = join(app.runtime.workspace, "garden-app");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tomatoes.txt"), "water daily\n");
  const runner = new GitRunner();
  const run = async (args) => {
    const out = await runner.run({ cwd: folder, args }, AbortSignal.timeout(30000));
    assert.equal(out.status, "completed", `${args.join(" ")}: ${out.stderr}`);
  };
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Test Owner"]);
  await run(["config", "user.email", "owner@example.invalid"]);
  await run(["add", "tomatoes.txt"]);
  await run(["commit", "-m", "Start the garden log"]);
  await writeFile(join(folder, "tomatoes.txt"), "water daily\nfeed weekly\n"); // left dirty, for "Read its current status"
  app.store.projects.save(owner, { id: "garden-app", name: "Garden app", folder: "garden-app" });
  await fetch(`${server.url}/api/onboarding`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "schedules");

  const panel = page.locator('[data-part="git"]');
  await panel.waitFor({ state: "visible", timeout: 20000 });
  await panel.getByRole("heading", { name: "Git activity" }).waitFor({ state: "visible" });
  await panel.getByLabel("Repository", { exact: true }).selectOption({ label: "Garden app" });

  await panel.getByRole("button", { name: "Read its current status" }).click();
  const summary = panel.locator(".collab-meta").first();
  await summary.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await summary.innerText(), /main@[0-9a-f]{7}/);
  assert.match(await summary.innerText(), /1 files changed/);
  assert.match(await panel.getByLabel("Patch", { exact: true }).inputValue(), /feed weekly/);

  await panel.getByLabel("Title", { exact: true }).fill("Feed the tomatoes weekly");
  if (shots) await page.screenshot({ path: join(shots, "collab-git-before-publish.png") });
  await panel.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published.").first().waitFor({ state: "visible", timeout: 15000 });
  // Publishing clears the form, so publishing again would need a fresh "Read its current status".
  assert.equal(await panel.getByLabel("Title", { exact: true }).inputValue(), "");

  await panel.getByLabel("Search patches", { exact: true }).fill("weekly");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const card = panel.locator(".collab-card", { hasText: "Feed the tomatoes weekly" });
  await card.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await card.innerText(), /Garden app/);
  if (shots) await page.screenshot({ path: join(shots, "collab-git-panel.png") });

  const listed = await fetch(`${server.url}/api/collab/events?kind=git.patch&repository=garden-app`,
    { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].payload.title, "Feed the tomatoes weekly");
  assert.deepEqual(errors, []);
});
