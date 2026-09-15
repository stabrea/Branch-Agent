import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { request as httpRequest } from "node:http";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-server-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
  });
  t.after(async () => {
    await server.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, ...server };
}

test("private API requires token, validates origin and host, and rejects URL token", async (t) => {
  const { url, token } = await fixture(t);
  assert.equal((await fetch(url + "/api/state")).status, 401);
  assert.equal((await fetch(url + "/api/state?token=" + token)).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: {
          authorization: "Bearer " + token,
          origin: "https://evil.example",
        },
      })
    ).status,
    403,
  );
  const badHost = await new Promise((resolve) => {
    httpRequest(
      url + "/api/state",
      { headers: { authorization: "Bearer " + token, host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    ).end();
  });
  assert.equal(badHost, 403);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { authorization: "Bearer " + token, origin: url },
      })
    ).status,
    200,
  );
  const html = await (await fetch(url)).text();
  assert.match(html, /Branch/);
  assert.ok(!html.includes(token));
});

test("authenticated API executes real demo and exposes events and usage", async (t) => {
  const { url, token } = await fixture(t),
    headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      origin: url,
    };
  const response = await fetch(url + "/api/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "demo" }),
  });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.status, "completed");
  const detail = await (
    await fetch(url + "/api/runs/" + run.id, { headers })
  ).json();
  assert.equal(
    detail.events.filter((e) => e.kind === "tool.completed").length,
    3,
  );
  const state = await (await fetch(url + "/api/state", { headers })).json();
  assert.ok(state.runs[0].usage.estimatedInput > 0);
  const memoryResponse = await fetch(url + "/api/action", {
    method: "POST",
    headers,
    body: JSON.stringify({
      tool: "memory.put",
      args: { text: "tea", source: "test" },
    }),
  });
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json();
  assert.ok(memory.data.sourceRunId);
  const audit = await (
    await fetch(url + "/api/runs/" + memory.data.sourceRunId, { headers })
  ).json();
  assert.equal(audit.run.status, "completed");
  assert.ok(audit.events.some((e) => e.kind === "tool.completed"));
});

test("API validates malformed and oversized requests", async (t) => {
  const { url, token } = await fixture(t),
    headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    };
  assert.equal(
    (await fetch(url + "/api/run", { method: "POST", headers, body: "{" }))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(url + "/api/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "x".repeat(70000) }),
      })
    ).status,
    413,
  );
});
