import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { request as httpRequest } from "node:http";
import { discardTemp } from "./temp-dir.mjs";

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
    await app.close();
    await discardTemp(root);
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
  // A message may now bring files with it, so what a run's body may weigh is no longer 64 KiB: it is
  // 32 MiB of attachments as base64, plus room for the words. 70,000 characters of prompt is therefore
  // not an oversized request any more — it is a prompt longer than a prompt may be, refused as one.
  const tooManyWords = await fetch(url + "/api/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "x".repeat(70000) }),
  });
  assert.equal(tooManyWords.status, 400);

  // And a body past what a run may carry at all is still stopped by the reader, before anything is
  // parsed. 48 MB is past the ceiling on purpose: if the ceiling is ever raised above it, this goes
  // red and somebody decides that deliberately rather than by accident.
  assert.equal(
    (
      await fetch(url + "/api/run", {
        method: "POST",
        headers,
        body: `{"prompt":"${"x".repeat(48 * 1024 * 1024)}"}`,
      })
    ).status,
    413,
  );
});

test("the shared look needs the token, saves a real theme as the window's, and refuses the rest", async (t) => {
  const { url, token } = await fixture(t);
  const call = (method, body) => fetch(url + "/api/look", {
    method,
    headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await fetch(url + "/api/look")).status, 401);
  const saved = await call("POST", { contrast: "more", changedBy: "terminal" });
  assert.equal(saved.status, 200);
  const look = await saved.json();
  assert.equal(look.contrast, "more");
  assert.equal(look.changedBy, "window");
  assert.equal((await (await call("GET")).json()).contrast, "more");
  assert.equal((await call("POST", { theme: "no-such-theme" })).status, 400);
  assert.equal((await call("POST", { theme: "forest", colour: "#fff" })).status, 400);
  assert.equal((await call("DELETE")).status, 405);
});
