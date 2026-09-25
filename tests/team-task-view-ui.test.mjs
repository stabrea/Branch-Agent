/* Q64: a team's room shows the team's recent tasks with their state in Q51's words, in English and in
   French. Headless; the model is scripted. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveKnobs } from "../dist/knobs/settings.js";

const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };
const roleOf = (request) => /Your role in team \\?"Crew\\?": ([a-z]+)\./.exec(JSON.stringify(request.messages))?.[1] ?? null;
/** Members answer by role; the team's own turn writes a file when the prompt asks for notes (and so asks first). */
const model = { name: "scripted", async complete(request) {
  const role = roleOf(request);
  if (role) return { content: `answer from ${role}`, toolCalls: [] };
  if (JSON.stringify(request.messages).includes("write the notes") && request.messages.at(-1)?.role !== "tool")
    return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "one" }) }] };
  return { content: "parent done", toolCalls: [] };
} };

test("the team's room lists its tasks with Q51's state words, in English and in French", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-team-view-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const members = ["planner", "builder", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { id: specialistId, name: role });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Crew", members });
  saveKnobs(app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const done = await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  const waiting = await app.teams.run(app.runtime, knowledge, team.id, "write the notes", { requestId: randomUUID() });
  assert.deepEqual([done.state, waiting.state], ["completed", "waiting_owner"]);
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });

  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => globalThis.branchTeamTasks);
  await page.evaluate(async (id) => { const app = await import("/app.js"); app.displayView("chat"); await app.openConversation(id); }, team.roomSessionId);

  const card = page.locator("#team-tasks");
  const state = (taskId) => card.locator(`[data-team-task="${taskId}"] .team-task-state`);
  await card.waitFor({ state: "visible" });
  await assert.doesNotReject(state(done.taskId).filter({ hasText: /^Done$/ }).waitFor());
  assert.equal(await state(waiting.taskId).textContent(), "Waiting for your answer");
  assert.match(await card.locator(`[data-team-task="${waiting.taskId}"] .team-task-blocker`).textContent(), /^It asked: .*notes\.txt/);
  const reviewer = card.locator(`[data-team-task="${done.taskId}"] .team-task-member`).nth(2);
  assert.match(await reviewer.textContent(), /^reviewer: Done · batch 2 · answers after planner, builder, once their batch has finished/);

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await assert.doesNotReject(state(done.taskId).filter({ hasText: /^Terminée$/ }).waitFor());
  assert.equal(await state(waiting.taskId).textContent(), "En attente de votre réponse");
  assert.equal(await card.locator("h3").textContent(), "Tâches récentes de cette équipe");
  assert.match(await reviewer.textContent(), /^reviewer: Terminée · lot 2 · répond après planner, builder/);
  assert.deepEqual(errors, []);
});
