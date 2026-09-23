/**
 * FQ-packages.trajectories: a batch of named tasks' trajectories in one call — the same shape the
 * single-run route already hands back, just many at once — plus the same lines as a real gzip
 * (node:zlib), not a renamed file. Both are refused to a short-lived key, even a "run" one, because
 * a batch carries many tasks' full messages and tool arguments at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { trajectoryBatchCap } from "../dist/trajectory.js";

/** A workspace, a server and a scripted provider that never calls a model, cleaned up after. */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trajectory-batch-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, key, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    const parsed = contentType.includes("application/json") ? JSON.parse(bytes.toString("utf8") || "null") : null;
    return { status: response.status, body: parsed, bytes, contentType };
  };
  const api = (method, path, body) => call(method, path, server.token, body);
  return { app, server, api, call };
}

/** exportedAt is stamped fresh (`new Date().toISOString()`) each time a trajectory is built, so
 *  two builds of the very same task never match on that one field alone. Everything else must. */
function withoutExportedAt(document) {
  const { exportedAt, ...rest } = document;
  return rest;
}

test("FQ a batch of three named runs equals fetching each one on its own", async (t) => {
  const { api } = await served(t);
  const runIds = [];
  for (const prompt of ["one", "two", "three"]) {
    const run = (await api("POST", "/api/run", { prompt })).body;
    assert.equal(run.status, "completed");
    runIds.push(run.id);
  }

  const singles = [];
  for (const runId of runIds) {
    const single = await api("GET", `/api/runs/${runId}/trajectory`);
    assert.equal(single.status, 200);
    singles.push(single.body);
  }

  const batch = await api("GET", `/api/runs/trajectories/batch?ids=${runIds.join(",")}`);
  assert.equal(batch.status, 200);
  assert.equal(batch.body.trajectories.length, 3, "one document per id, in the order asked for");
  batch.body.trajectories.forEach((document, i) => {
    assert.equal(document.run.id, runIds[i]);
    assert.deepEqual(withoutExportedAt(document), withoutExportedAt(singles[i]),
      "the batch's document for a run is exactly what the single-run route hands back for it");
  });
});

test("FQ the gzip form gunzips to exactly the JSON Lines of the batch", async (t) => {
  const { api, call, server } = await served(t);
  const runIds = [];
  for (const prompt of ["a", "b"]) runIds.push((await api("POST", "/api/run", { prompt })).body.id);

  const gz = await call("GET", `/api/runs/trajectories/batch.jsonl.gz?ids=${runIds.join(",")}`, server.token);
  assert.equal(gz.status, 200);
  assert.match(gz.contentType, /gzip/);
  // A real gzip stream starts with the two magic bytes, not a plain-text file renamed.
  assert.equal(gz.bytes[0], 0x1f);
  assert.equal(gz.bytes[1], 0x8b);

  const jsonl = await call("GET", `/api/runs/trajectories.jsonl?limit=10`, server.token);
  assert.equal(jsonl.status, 200);
  const linesByRun = new Map(
    jsonl.bytes.toString("utf8").trim().split("\n").map((line) => [JSON.parse(line).run.id, line]),
  );
  const expected = runIds.map((id) => linesByRun.get(id)).join("\n") + "\n";

  // exportedAt is stamped fresh on every build, so the gzip route's own build and the plain
  // .jsonl route's build of the very same task never share that one field; strip it from both
  // before comparing the rest byte for byte.
  const stripExportedAt = (text) => text.replaceAll(/"exportedAt":"[^"]*"/g, '"exportedAt":""');
  const gunzipped = gunzipSync(gz.bytes).toString("utf8");
  assert.equal(stripExportedAt(gunzipped), stripExportedAt(expected),
    "gunzipping the batch gives exactly its JSON Lines, newest asked for last");
});

test("FQ a batch over the cap is a clear 4xx before anything is read", async (t) => {
  const { call, server } = await served(t);
  const tooMany = Array.from({ length: trajectoryBatchCap + 1 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
  const refused = await call("GET", `/api/runs/trajectories/batch?ids=${tooMany}`, server.token);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error ?? "", new RegExp(String(trajectoryBatchCap)));

  const refusedGz = await call("GET", `/api/runs/trajectories/batch.jsonl.gz?ids=${tooMany}`, server.token);
  assert.equal(refusedGz.status, 400);
});

test("FQ ?session= returns exactly that session's runs, newest first", async (t) => {
  const { api } = await served(t);
  const first = (await api("POST", "/api/run", { prompt: "one" })).body;
  const sessionId = first.sessionId;
  const second = (await api("POST", "/api/run", { prompt: "two", sessionId })).body;
  await api("POST", "/api/run", { prompt: "a different conversation" });

  const filtered = await api("GET", `/api/runs/trajectories/batch?session=${sessionId}`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.trajectories.map((doc) => doc.run.id), [second.id, first.id],
    "both of this session's runs, and only this session's, newest first");
});

test("FQ ?since=/?until= bound the batch by created_at", async (t) => {
  const { app, api } = await served(t);
  const early = (await api("POST", "/api/run", { prompt: "early" })).body;
  const late = (await api("POST", "/api/run", { prompt: "late" })).body;
  // Test-only: reach through the store's own db handle to push "early" well into the past, the same
  // way tests/residuals.test.mjs backdates a run — since/until can only be proven apart this way.
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", early.id);

  const sinceLate = await api("GET", "/api/runs/trajectories/batch?since=2025-01-01T00:00:00.000Z");
  assert.equal(sinceLate.status, 200);
  assert.deepEqual(sinceLate.body.trajectories.map((doc) => doc.run.id), [late.id]);

  const untilEarly = await api("GET", "/api/runs/trajectories/batch?until=2021-01-01T00:00:00.000Z");
  assert.equal(untilEarly.status, 200);
  assert.deepEqual(untilEarly.body.trajectories.map((doc) => doc.run.id), [early.id]);
});

test("FQ ?until= as a bare day means the end of that UTC day, not midnight", async (t) => {
  const { app, api } = await served(t);
  const afternoon = (await api("POST", "/api/run", { prompt: "afternoon" })).body;
  // Test-only backdating, same as above: a run made that afternoon, well past midnight UTC.
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2026-09-23T18:30:00.000Z", afternoon.id);
  const nextDay = (await api("POST", "/api/run", { prompt: "next day" })).body;
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2026-09-24T00:00:01.000Z", nextDay.id);

  const filtered = await api("GET", "/api/runs/trajectories/batch?until=2026-09-23");
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.trajectories.map((doc) => doc.run.id), [afternoon.id],
    "a bare-day until still includes a run made that same afternoon");
});

test("FQ a since with a numeric UTC offset is normalised before comparing", async (t) => {
  const { app, api } = await served(t);
  // 2026-09-23T12:00:00+02:00 is 2026-09-23T10:00:00.000Z: one run one millisecond either side of it.
  const before = (await api("POST", "/api/run", { prompt: "before" })).body;
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2026-09-23T09:59:59.999Z", before.id);
  const after = (await api("POST", "/api/run", { prompt: "after" })).body;
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2026-09-23T10:00:00.000Z", after.id);

  const since = encodeURIComponent("2026-09-23T12:00:00+02:00");
  const filtered = await api("GET", `/api/runs/trajectories/batch?since=${since}`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.trajectories.map((doc) => doc.run.id), [after.id],
    "the offset is converted to UTC before the boundary is compared, not string-compared as written");
});

test("FQ a locale date string is refused, not silently parsed by Date.parse alone", async (t) => {
  const { api } = await served(t);
  const refused = await api("GET", `/api/runs/trajectories/batch?since=${encodeURIComponent("September 23, 2026")}`);
  assert.equal(refused.status, 400);
});

test("FQ ids and a filter are mutually exclusive", async (t) => {
  const { api } = await served(t);
  const run = (await api("POST", "/api/run", { prompt: "x" })).body;
  const refused = await api("GET", `/api/runs/trajectories/batch?ids=${run.id}&session=${run.sessionId}`);
  assert.equal(refused.status, 400);
});

test("FQ a bad date is refused with a 400, not read as a filter that matches nothing", async (t) => {
  const { api } = await served(t);
  const refused = await api("GET", "/api/runs/trajectories/batch?since=not-a-date");
  assert.equal(refused.status, 400);
});

test("FQ a filter matching more than the limit is refused, not silently truncated", async (t) => {
  const { api } = await served(t);
  const first = (await api("POST", "/api/run", { prompt: "one" })).body;
  await api("POST", "/api/run", { prompt: "two", sessionId: first.sessionId });

  const refused = await api("GET", `/api/runs/trajectories/batch?session=${first.sessionId}&limit=1`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error ?? "", /more than 1/);
});

test("FQ the gz form with a filter gunzips to exactly the same lines as the plain form", async (t) => {
  const { api, call, server } = await served(t);
  const first = (await api("POST", "/api/run", { prompt: "a" })).body;
  await api("POST", "/api/run", { prompt: "b", sessionId: first.sessionId });
  await api("POST", "/api/run", { prompt: "elsewhere" });

  const plain = await api("GET", `/api/runs/trajectories/batch?session=${first.sessionId}`);
  assert.equal(plain.status, 200);
  const plainLines = plain.body.trajectories.map((document) => JSON.stringify(withoutExportedAt(document)));

  const gz = await call("GET", `/api/runs/trajectories/batch.jsonl.gz?session=${first.sessionId}`, server.token);
  assert.equal(gz.status, 200);
  const gzLines = gunzipSync(gz.bytes).toString("utf8").trim().split("\n")
    .map((line) => JSON.stringify(withoutExportedAt(JSON.parse(line))));
  assert.deepEqual(gzLines, plainLines);
});

test("FQ a non-owner short-lived key is refused the batch, gzipped or not", async (t) => {
  const { api, call, app, server } = await served(t);
  const runId = (await api("POST", "/api/run", { prompt: "solo" })).body.id;
  const runKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const readKey = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token;

  for (const key of [runKey, readKey]) {
    const plain = await call("GET", `/api/runs/trajectories/batch?ids=${runId}`, key);
    assert.equal(plain.status, 401, "a short-lived key, run or read, may not read a batch");
    const gz = await call("GET", `/api/runs/trajectories/batch.jsonl.gz?ids=${runId}`, key);
    assert.equal(gz.status, 401);
  }

  // The single-run route stays open to a "run" key, unlike the batch: the guard is on the batch,
  // not on trajectories in general.
  const single = await call("GET", `/api/runs/${runId}/trajectory`, runKey);
  assert.equal(single.status, 200);
});

test("FQ runsFiltered lands on the tasks_owner_created/tasks_owner_session_created index, never a scan", async (t) => {
  const { app } = await served(t);
  const byOwnerAndDate = app.store.explainRunsFiltered("owner-x", { since: "2026-01-01T00:00:00.000Z" }, 10);
  assert.ok(byOwnerAndDate.some((line) => /SEARCH tasks USING (COVERING )?INDEX tasks_owner_created/.test(line)),
    `expected the owner+created_at index, got: ${byOwnerAndDate.join(" | ")}`);
  assert.ok(!byOwnerAndDate.some((line) => /\bSCAN tasks\b/.test(line)),
    `expected no full scan, got: ${byOwnerAndDate.join(" | ")}`);

  const byOwnerAndSession = app.store.explainRunsFiltered("owner-x", { sessionId: "some-session" }, 10);
  assert.ok(byOwnerAndSession.some((line) => /SEARCH tasks USING (COVERING )?INDEX tasks_owner_session_created/.test(line)),
    `expected the owner+session+created_at index, got: ${byOwnerAndSession.join(" | ")}`);
  assert.ok(!byOwnerAndSession.some((line) => /\bSCAN tasks\b/.test(line)),
    `expected no full scan, got: ${byOwnerAndSession.join(" | ")}`);
});

test("FQ a filtered batch never returns another owner's run, even inside the window", async (t) => {
  const { app, api } = await served(t);
  const mine = (await api("POST", "/api/run", { prompt: "mine" })).body;
  // Test-only: created straight through the store, not the HTTP API (which always files a run
  // under the caller), so a run owned by someone else can sit in the very same window this filter
  // asks for and prove the owner clause, not just the date clause, is what keeps it out.
  const theirs = app.store.createRun("someone-else", "not mine");
  app.store.finish(theirs.id, "completed", "done");

  const filtered = await api("GET", "/api/runs/trajectories/batch?since=2000-01-01");
  assert.equal(filtered.status, 200);
  const ids = filtered.body.trajectories.map((doc) => doc.run.id);
  assert.ok(ids.includes(mine.id), "the caller's own run is in the window");
  assert.ok(!ids.includes(theirs.id), "another owner's run must never appear in this owner's filtered batch");
});
