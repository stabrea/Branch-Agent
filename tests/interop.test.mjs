import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, promptFrom } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted() {
  const provider = { name: "scripted", requests: [], holds: new Map(), async complete(request) {
    provider.requests.push(request);
    const user = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    for (const [needle, hold] of provider.holds) if (user.includes(needle))
      await Promise.race([hold, new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))]);
    request.signal.throwIfAborted();
    const words = `Echo: ${user.slice(0, 60)}`;
    request.onTextDelta?.(words.slice(0, 5)); request.onTextDelta?.(words.slice(5));
    return { content: words, toolCalls: [] };
  } };
  return provider;
}
async function fixture(t, dataDir) {
  const root = await mkdtemp(join(tmpdir(), "branch-interop-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: dataDir ?? join(root, "data"), provider });
  const server = await startServer(app, { dataDir: dataDir ?? join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = (extra = {}) => ({ authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json", ...extra });
  const api = async (path, body, extra) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST", headers: headers(extra), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? JSON.stringify(json));
    return json;
  };
  return { app, root, provider, server, api, headers };
}
const untilTrue = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25); } assert.fail(`Timed out: ${label}`); };

test("the OpenAI-style endpoint completes a conversation request, continues a session, lists models and streams chunks", async (t) => {
  const { app, api, server, headers, provider } = await fixture(t);
  const first = await api("/v1/chat/completions", { model: "not-a-preset", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hello there" }] });
  assert.equal(first.object, "chat.completion");
  assert.equal(first.choices[0].message.role, "assistant");
  assert.match(first.choices[0].message.content, /^Echo: Instructions from the calling program:/);
  assert.equal(first.choices[0].finish_reason, "stop");
  assert.ok(first.usage.total_tokens > 0);
  assert.match(first.branch.session_id, /^[a-f0-9-]{36}$/);
  const second = await api("/v1/chat/completions", { messages: [{ role: "user", content: "and again" }] }, { "x-branch-session": first.branch.session_id });
  assert.equal(second.branch.session_id, first.branch.session_id);
  assert.ok(provider.requests.at(-1).messages.some((m) => m.role === "assistant" && /Echo:/.test(m.content)), "the earlier turn is part of the continued conversation");
  await assert.rejects(api("/v1/chat/completions", { messages: [{ role: "assistant", content: "no user" }] }), /needs a user message/);
  const models = await api("/v1/models");
  assert.equal(models.object, "list");
  assert.ok(models.data.some((m) => m.id === app.runtime.models.default.id));
  assert.equal(promptFrom({ messages: [{ role: "user", content: [{ type: "text", text: "parts " }, { type: "text", text: "joined" }] }] }), "parts joined");
  const streamed = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: headers(), body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "stream me" }] }) });
  assert.equal(streamed.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const lines = (await streamed.text()).split("\n").filter((l) => l.startsWith("data: "));
  assert.equal(lines.at(-1), "data: [DONE]");
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const content = chunks.flatMap((c) => c.choices[0]?.delta?.content ?? "").join("");
  assert.equal(content, "Echo: stream me");
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason, "stop");
  assert.ok(chunks.at(-1).branch.run_id, "the last chunk names the Branch run");
});

test("run events stream in order over SSE until the run ends, resuming after a given id", async (t) => {
  const { app, server, headers, provider } = await fixture(t);
  let release; provider.holds.set("slow one", new Promise((r) => { release = r; }));
  const pending = app.runtime.run({ prompt: "slow one" });
  await untilTrue(() => app.store.runs("local").length === 1, "run started");
  const run = app.store.runs("local")[0];
  const streamPromise = fetch(server.url + `/api/runs/${run.id}/stream`, { headers: headers() });
  await delay(100); release();
  const finished = await pending;
  assert.equal(finished.status, "completed");
  const body = await (await streamPromise).text();
  const events = body.split("\n\n").filter(Boolean).map((block) => Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)])));
  const ids = events.filter((e) => e.id).map((e) => Number(e.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "events arrive in id order");
  assert.equal(events[0].event, "run.started");
  assert.ok(events.some((e) => e.event === "run.finished"));
  assert.deepEqual(JSON.parse(events.at(-1).data), { status: "completed" });
  assert.equal(events.at(-1).event, "end");
  const resumed = await (await fetch(server.url + `/api/runs/${run.id}/stream?after=${ids[2]}`, { headers: headers() })).text();
  const resumedIds = resumed.split("\n").filter((l) => l.startsWith("id: ")).map((l) => Number(l.slice(4)));
  assert.equal(resumedIds[0], ids[3], "resuming skips what the client already saw");
});

test("messages sent while a conversation is busy wait their turn and run in order", async (t) => {
  const { app, api, provider } = await fixture(t);
  let release; provider.holds.set("first task", new Promise((r) => { release = r; }));
  const first = app.runtime.run({ prompt: "first task" });
  await untilTrue(() => app.store.runs("local").length === 1, "first run started");
  const sessionId = app.store.runs("local")[0].sessionId;
  await assert.rejects(app.runtime.run({ prompt: "direct", sessionId }), /already has an active run/, "direct runs still refuse a busy session");
  const q1 = await api(`/api/sessions/${sessionId}/followups`, { prompt: "second please" });
  const q2 = await api(`/api/sessions/${sessionId}/followups`, { prompt: "third please" });
  assert.deepEqual([q1.position, q1.queued, q2.position, q2.queued], [1, 1, 2, 2]);
  const live = await api("/api/activity");
  assert.equal(live[0].followUps, 2);
  assert.deepEqual((await api(`/api/sessions/${sessionId}/followups`)).followUps.map((f) => f.prompt), ["second please", "third please"]);
  release();
  await first;
  await untilTrue(() => app.store.runs("local").filter((r) => r.sessionId === sessionId && r.status === "completed").length === 3, "both follow-ups ran");
  const users = app.store.messages(sessionId).filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["first task", "second please", "third please"]);
  assert.deepEqual((await api(`/api/sessions/${sessionId}/followups`)).followUps, []);
  const idle = await api(`/api/sessions/${sessionId}/followups`, { prompt: "fourth, nobody busy" });
  assert.equal(idle.position, 1);
  await untilTrue(() => app.store.messages(sessionId).some((m) => m.role === "user" && m.content === "fourth, nobody busy"), "an idle conversation runs the message right away");
});

test("a background specialist finishes after its parent and the result is kept for the parent", async (t) => {
  const { app, api, provider } = await fixture(t);
  const parent = await app.runtime.run({ prompt: "parent task" });
  const context = app.runtime.context({ runId: parent.id });
  let release; provider.holds.set("long research", new Promise((r) => { release = r; }));
  const started = await app.runtime.delegateBackground("long research", context, ["files.read"], "You research.", { timeoutMs: 30000 });
  assert.match(started.childRunId, /^[a-f0-9-]{36}$/);
  assert.equal(app.store.run(started.childRunId).status, "running");
  assert.ok(app.store.events(parent.id).some((e) => e.kind === "delegation.background_started" && e.data.childRunId === started.childRunId));
  release();
  await untilTrue(() => app.store.run(started.childRunId).status === "completed", "child finished on its own");
  await untilTrue(() => app.store.events(parent.id).some((e) => e.kind === "delegation.background_finished"), "parent received the result");
  const finished = app.store.events(parent.id).find((e) => e.kind === "delegation.background_finished").data;
  assert.equal(finished.status, "completed");
  assert.match(finished.output, /Echo: long research/);
  const state = await api("/api/state");
  assert.equal(state.background[0].childRunId, started.childRunId);
  const tool = app.registry.descriptions(new Set(["specialists.use"])).find((d) => d.name === "specialists.delegate");
  assert.ok(JSON.stringify(tool.parameters).includes("background"), "the tool exposes the background option");
});

test("a backup restores conversations, memory and skills into a fresh install, without secrets", async (t) => {
  const source = await fixture(t);
  const run = await source.app.runtime.run({ prompt: "remember the garden" });
  source.app.store.save("memory", "local", "m1", { text: "Has a garden", source: "owner" });
  source.app.store.skills.install("local", { document: "---\nname: gardener\ndescription: Gardening help.\n---\nWater plants.\n" });
  await source.app.store.locker.set("local", "default", "API_TOKEN", "super-secret-value").catch(() => undefined);
  const archive = await source.api("/api/backup");
  assert.equal(archive.format, "branch-agent-backup");
  assert.ok(!("locker" in archive.tables), "secrets are not part of a backup");
  assert.equal(JSON.stringify(archive).includes("super-secret-value"), false);
  assert.equal(archive.tables.sessions.length, 1);
  await assert.rejects(source.api("/api/restore", archive), /already has conversations/);
  const target = await fixture(t);
  const result = await target.api("/api/restore", archive);
  assert.ok(result.rows > 5 && result.tables >= 5, JSON.stringify(result));
  assert.equal(target.app.store.run(run.id).prompt, "remember the garden");
  assert.deepEqual(target.app.store.messages(run.sessionId).map((m) => m.role), ["user", "assistant"]);
  assert.equal(target.app.store.get("memory", "local", "m1").data.text, "Has a garden");
  assert.equal(target.app.store.skills.list("local")[0].name, "gardener");
  const state = await target.api("/api/state");
  assert.equal(state.runs.length, 1);
});

test("the health check names what works and what to do about what does not", async (t) => {
  const { app, api } = await fixture(t);
  const report = await api("/api/health");
  assert.equal(report.ok, true, JSON.stringify(report.items.filter((i) => !i.ok)));
  assert.deepEqual(report.items.map((i) => i.name), ["Saved data", "Workspace folder", "Device key", "Models", "Models on this computer", "Channels", "Schedules", "Tasks waiting for you"]);
  const broken = { name: "broken", async complete() { throw new Error("connection refused"); } };
  app.runtime.models.register({ id: "broken", name: "Broken box", provider: broken, model: "x" });
  app.runtime.models.configure("local", { activePreset: "broken" });
  const probed = await api("/api/health?probe=1");
  const models = probed.items.find((i) => i.name === "Models");
  assert.equal(models.ok, false);
  assert.match(models.summary, /did not answer/);
  assert.match(models.fix, /Settings → Models/);
  assert.equal(probed.ok, false);
  const tasks = probed.items.find((i) => i.name === "Tasks waiting for you");
  assert.equal(tasks.ok, true);
});
