/**
 * Owner item 17: a skill marked **Always follow** has its full instructions in every task, instead of a
 * line in the list the assistant may never open (the owner's example: an agent ignored a skill saying
 * "always submit the quiz"). Only what the task may read and the owner's rules allow is included, it
 * grants nothing, and a short-lived key cannot change the list.
 */
import test from "node:test";
import { alwaysSkillsRoute } from "../dist/skill-tools.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const QUIZ = "---\nname: submit-quiz\ndescription: How quizzes are handed in.\n---\n\nALWAYS press Submit on the quiz before you finish. Never leave it unsubmitted.\n";

async function fixture(t) {
  const prompts = [];
  const root = await mkdtemp(join(tmpdir(), "branch-skills-always-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { prompts.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")); return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const skill = app.store.skills.install(app.runtime.owner, { document: QUIZ });
  return { app, server, call, prompts, skillId: skill.id ?? skill.skillId ?? app.store.skills.catalog(app.runtime.owner)[0].id };
}

test("unmarked, the skill is only a line in the list; marked, its whole text is in every task", async (t) => {
  const { app, call, prompts, skillId } = await fixture(t);
  await app.runtime.run({ prompt: "Do my homework", permissions: ["skills.read"] });
  assert.ok(!prompts.at(-1).includes("ALWAYS press Submit"), "not marked: only the name and description travel");
  assert.deepEqual((await call("/api/skills/always")).body, { ids: [] });
  assert.deepEqual((await call("/api/skills/always", { id: skillId, always: true })).body, { ids: [skillId] });
  await app.runtime.run({ prompt: "Do my homework", permissions: ["skills.read"] });
  assert.match(prompts.at(-1), /followed in every task[\s\S]*ALWAYS press Submit on the quiz/);
  assert.match(prompts.at(-1), /never grant a permission/);
  await call("/api/skills/always", { id: skillId, always: false });
  await app.runtime.run({ prompt: "Do my homework", permissions: ["skills.read"] });
  assert.ok(!prompts.at(-1).includes("ALWAYS press Submit"), "unmarked again");
});

test("a task that may not read skills, and a skill that is switched off, get nothing", async (t) => {
  const { app, call, prompts, skillId } = await fixture(t);
  await call("/api/skills/always", { id: skillId, always: true });
  await app.runtime.run({ prompt: "Do my homework", permissions: [] });
  assert.ok(!prompts.at(-1).includes("ALWAYS press Submit"), "no skills.read, nothing of any skill");
  app.store.skills.disable(app.runtime.owner, skillId, { expectedRevision: app.store.skills.view(app.runtime.owner, skillId).revision });
  await app.runtime.run({ prompt: "Do my homework", permissions: ["skills.read"] });
  assert.ok(!prompts.at(-1).includes("ALWAYS press Submit"), "a switched-off skill is not followed");
});

test("the list refuses a made-up skill and a short-lived key", async (t) => {
  const { app, call, skillId } = await fixture(t);
  assert.equal((await call("/api/skills/always", { id: "11111111-2222-4333-8444-555555555555", always: true })).status, 400);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call("/api/skills/always", { id: skillId, always: true }, key)).status));
  assert.ok([401, 403].includes((await call("/api/skills/always", undefined, key)).status), "nor read the list");
  assert.deepEqual((await call("/api/skills/always")).body, { ids: [] }, "nothing was changed");
});

test("a household profile can neither read nor change the skills followed in every task", async (t) => {
  const { app, call, skillId } = await fixture(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call("/api/skills/always")).status, 200);
  assert.notEqual((await call("/api/skills/always", { id: skillId, always: true })).status, 200);
  // The route's own guard (it names itself) is what stays if the outer table is ever refactored.
  for (const method of ["GET", "POST"])
    await assert.rejects(alwaysSkillsRoute(app.store, app.runtime.owner, method, async () => ({ id: skillId, always: true })),
      /^Error: Skills followed in every task belongs to the owner/);
  app.store.profiles.switch({ profileId: null });
  assert.deepEqual((await call("/api/skills/always")).body, { ids: [] }, "nothing was changed");
});

test("each skill in the list has an Always follow switch that is saved", async (t) => {
  const { chromium } = await import("playwright");
  const { app, server, skillId } = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "customize:skills").catch(async () => { await page.evaluate(() => document.getElementById("skills-list")?.scrollIntoView()); });
  const card = page.locator(`#skills-list [data-skill-id="${skillId}"]`);
  await card.waitFor({ state: "attached" });
  const toggle = card.getByRole("switch", { name: "Always follow" });
  assert.equal(await toggle.isChecked(), false);
  await toggle.evaluate((node) => node.click());
  for (let i = 0; i < 50 && !(app.store.get("settings", app.runtime.owner, "skills-always")?.data?.ids ?? []).includes(skillId); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(app.store.get("settings", app.runtime.owner, "skills-always").data.ids, [skillId]);
  assert.deepEqual(errors, []);
});
