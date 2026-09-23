import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * FQ-delegation.persistent-teams gap: the original restart test (teams-registry.test.mjs) only
 * checked the team's name and the room's message count after a restart. It never asserted that
 * each member kept its role (and brief), that the roles are readable through the owner-facing
 * API on the fresh instance, or that a restarted team still delegates with the right role text.
 * This file closes that gap without touching the other test file, so it stays out of the way of
 * other agents working on teams-registry.test.mjs at the same time.
 */
const say = (content) => () => ({ content, toolCalls: [] });
function scripted(initial) {
  const provider = { name: "scripted", requests: [], steps: initial, index: 0, async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0].content;
    const roleStep = provider.byRole?.find(([needle]) => system.includes(needle));
    if (roleStep) return roleStep[1](request);
    return provider.steps[Math.min(provider.index++, provider.steps.length - 1)](request);
  } };
  provider.reset = (steps) => { provider.steps = steps; provider.index = 0; };
  return provider;
}
async function fixture(t, steps = [say("ok")], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-teams-restart-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (base, path, body) => {
    const response = await fetch(base.url + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + base.token, origin: base.url, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
  };
  return { app, root, provider, server, api: (path, body) => api(server, path, body) };
}
/** An evaluated, promoted specialist the runtime will delegate to. */
async function specialist(app, name) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", { name, instructions: `You are the ${name}.`, permissions: ["files.read"], evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] } }, context);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

test("each team member's role (and brief) survives a restart, in the library, through the owner-facing API, and still drives delegation", async (t) => {
  const { app, root, provider, api } = await fixture(t);
  const planner = await specialist(app, "planner"), critic = await specialist(app, "critic");
  provider.byRole = [["You are the planner", say("Plan: three steps")], ["You are the critic", say("Critique: step two is weak")]];
  const team = await api("teams", { name: "Launch crew", purpose: "Ship the newsletter.", members: [{ specialistId: planner, role: "Planner", brief: "Lay out the steps." }, { specialistId: critic, role: "Critic" }] });
  await api(`teams/${team.id}/run`, { prompt: "How do we launch on Friday?" });

  await app.close();
  const again = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server2 = await startServer(again, { dataDir: join(root, "data"), port: 0 });
  try {
    // Library check: the roles (and briefs) come back exactly, in member order.
    const restarted = again.teams.get(team.id);
    assert.deepEqual(restarted.members, [
      { specialistId: planner, role: "Planner", brief: "Lay out the steps." },
      { specialistId: critic, role: "Critic", brief: "" },
    ]);

    // Owner-facing check: the same roles are readable through the API on the fresh instance.
    const api2 = async (path, body) => {
      const response = await fetch(server2.url + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + server2.token, origin: server2.url, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
    };
    const viaApi = await api2(`teams/${team.id}`);
    assert.deepEqual(viaApi.members.map((m) => [m.role, m.brief]), [["Planner", "Lay out the steps."], ["Critic", ""]]);

    // Roles still drive delegation after the restart, not just the room history.
    provider.reset([say("team parent, second run")]);
    const result = await api2(`teams/${team.id}/run`, { prompt: "And the follow-up?" });
    assert.deepEqual(result.answers.map((a) => [a.role, a.output]), [["Planner", "Plan: three steps"], ["Critic", "Critique: step two is weak"]]);
    const room = (await api2(`teams/${team.id}/room`)).messages;
    assert.equal(room.length, 7, "system + first run's user/assistant/assistant + second run's user/assistant/assistant");
    assert.match(room[5].content, /^\[Planner\] Plan/);
    assert.match(room[6].content, /^\[Critic\] Critique/);
    const plannerRequest = provider.requests.filter((r) => /You are the planner/.test(r.messages[0].content)).at(-1);
    assert.match(plannerRequest.messages.find((m) => m.role === "user").content, /Your role in team "Launch crew": Planner\. Lay out the steps\./);
    assert.deepEqual(again.teams.remove(team.id), { removed: true });
  } finally {
    // Close the restarted app and its server before the fixture's own `t.after` tries to remove
    // the temp data directory, or the removal races an open sqlite handle on Windows (EBUSY).
    await server2.close();
    await again.close();
  }
});
