import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * FQ-execution.remote (serverless half): a function reached over HTTPS, held to the same
 * allowed-program rule as `RemoteWorkspaces` in tests/sandbox-remote.test.mjs. Two kinds of
 * double are used here, on purpose: a scripted `ServerlessInvoke` for the allowlist and schema
 * behaviour (so exact calls can be asserted), and one real local HTTP server driven through the
 * genuine `serverlessInvoker()` for the wire-format and byte-cap behaviour, so the production
 * `fetch` path is actually exercised rather than only ever mocked away.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-serverless-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

/** A context good enough for a tool that only wants the workspace, a run id and a signal. */
const contextOf = (app, extra = {}) => ({
  owner: "local", workspace: app?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for `ServerlessInvoke`: it answers exactly what the test scripts, and remembers every call. */
function fakeInvoke(answers = {}) {
  const calls = [];
  const invoke = async (url, body) => {
    calls.push({ url, ...body });
    const answer = answers[body.function];
    if (!answer) return { ok: false, statusCode: 404, body: "" };
    return { ok: answer.ok !== false, statusCode: answer.statusCode ?? 200, body: answer.body ?? "" };
  };
  return { calls, invoke, last: () => calls.at(-1) };
}

// ------------------------------------------------------------ add(): refused, not trusted

test("an endpoint is only accepted once it actually answers Branch's own probe, and starts able to run nothing", async (t) => {
  const { app } = await fixture(t);
  const { ServerlessEndpoints } = await import("../dist/remote/serverless-workspace.js");
  const world = fakeInvoke({ __branch_probe__: { ok: true, body: "" } });
  const endpoints = new ServerlessEndpoints(app.store, "local", world.invoke);

  const added = await endpoints.add({ id: "reports", url: "https://reports.example.workers.dev", label: "Reports" },
    AbortSignal.timeout(5000));
  assert.equal(added.id, "reports");
  assert.deepEqual(added.functions, [], "a new endpoint may run nothing at all until the owner says so");
  assert.equal(world.last().function, "__branch_probe__", "the probe is sent before anything is trusted");
  assert.equal(endpoints.list().length, 1);
  assert.equal(endpoints.get("reports").url, "https://reports.example.workers.dev");
  assert.throws(() => endpoints.get("nowhere"), /not one of the serverless functions/);
  assert.equal(endpoints.remove("reports"), true);
  assert.equal(endpoints.remove("reports"), false);
});

test("an endpoint that never answers the probe is refused, never saved", async (t) => {
  const { app } = await fixture(t);
  const { ServerlessEndpoints } = await import("../dist/remote/serverless-workspace.js");
  const world = fakeInvoke(); // no functions configured, so the probe itself gets a 404
  const endpoints = new ServerlessEndpoints(app.store, "local", world.invoke);

  await assert.rejects(endpoints.add({ id: "reports", url: "https://reports.example.workers.dev" },
    AbortSignal.timeout(5000)), /could not reach "reports"/);
  assert.equal(endpoints.list().length, 0, "nothing is saved when the endpoint never answers");
});

test("a plain http:// address is refused by the schema before any call is made", async (t) => {
  const { app } = await fixture(t);
  const { ServerlessEndpoints, ServerlessEndpointSchema } = await import("../dist/remote/serverless-workspace.js");
  const world = fakeInvoke({ __branch_probe__: { ok: true } });
  const endpoints = new ServerlessEndpoints(app.store, "local", world.invoke);

  assert.equal(ServerlessEndpointSchema.safeParse({ id: "reports", url: "http://reports.example.com" }).success, false);
  await assert.rejects(endpoints.add({ id: "reports", url: "http://reports.example.com" }, AbortSignal.timeout(5000)), /./);
  assert.equal(world.calls.length, 0, "an http:// address never reaches the invoker");
  assert.equal(endpoints.list().length, 0);
});

// ------------------------------------------------------------ execute(): the allowlist, exactly as SSH's

test("an endpoint may only call the functions the owner allowed, and the card names the endpoint", async (t) => {
  const { app } = await fixture(t);
  const { ServerlessEndpoints, registerServerlessEndpoints, explainServerless } =
    await import("../dist/remote/serverless-workspace.js");
  const world = fakeInvoke({ __branch_probe__: { ok: true }, build: { ok: true, body: "built ok" } });
  const endpoints = new ServerlessEndpoints(app.store, "local", world.invoke);
  await endpoints.add({ id: "reports", url: "https://reports.example.workers.dev", functions: ["build"] },
    AbortSignal.timeout(5000));

  await assert.rejects(endpoints.execute("reports", "wipe-database", [], AbortSignal.timeout(5000)),
    /"wipe-database" is not one of the functions "reports" is allowed to run/);
  const done = await endpoints.execute("reports", "build", ["march"], AbortSignal.timeout(5000));
  assert.equal(done.output, "built ok");
  assert.deepEqual(world.last(), { url: "https://reports.example.workers.dev", function: "build", args: ["march"] });

  // Already wired at start-up by `createBranch`, so registering the tools again must be refused —
  // that is the product wiring, asserted, not only the library function.
  assert.throws(() => registerServerlessEndpoints(app.registry, endpoints), /duplicate tool name/);
  const context = contextOf(app);
  assert.equal(app.registry.targetOf("serverless.run", { endpoint: "reports", function: "build", args: ["march"] }, context),
    "reports: build");
  // Calling a function on someone else's endpoint is the same permission as a program over SSH —
  // allowing shell commands must not quietly allow this too, and vice versa.
  assert.equal(app.registry.permissionOf("serverless.run"), "remote.execute");
  assert.equal(app.registry.permissionOf("remote.run"), app.registry.permissionOf("serverless.run"));
  assert.equal(app.registry.permissionOf("serverless.list"), "files.read");

  assert.match(explainServerless("reports", { statusCode: 404 }), /does not know that function/);
  assert.match(explainServerless("reports", { statusCode: 403 }), /refused Branch's request/);
  assert.match(explainServerless("reports", { statusCode: 0, error: "fetch failed" }), /did not answer|fetch failed/);
});

test("NUL, CR and LF in a function name or argument are rejected before any call is made", async (t) => {
  const { app } = await fixture(t);
  const { ServerlessEndpoints, ServerlessRunSchema } = await import("../dist/remote/serverless-workspace.js");
  const world = fakeInvoke({ __branch_probe__: { ok: true }, safe: { ok: true, body: "ok" } });
  const endpoints = new ServerlessEndpoints(app.store, "local", world.invoke);
  await endpoints.add({ id: "reports", url: "https://reports.example.workers.dev", functions: ["safe"] },
    AbortSignal.timeout(5000));
  const callsBefore = world.calls.length;

  for (const control of ["\0", "\r", "\n"]) {
    for (const name of [`${control}safe`, `sa${control}fe`, `safe${control}`]) {
      assert.equal(ServerlessRunSchema.safeParse({ endpoint: "reports", function: name }).success, false);
      await assert.rejects(endpoints.execute("reports", name, [], AbortSignal.timeout(5000)), /./);
    }
    for (const arg of [`${control}arg`, `bad${control}arg`, `arg${control}`])
      assert.equal(ServerlessRunSchema.safeParse({ endpoint: "reports", function: "safe", args: [arg] }).success, false);
  }
  assert.equal(world.calls.length, callsBefore, "invalid names never reach the invoker");
});

// ------------------------------------------------------------ the real fetch-based invoker, against a local double

async function startDouble(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the real invoker sends one JSON POST and reads back the function's own answer", async (t) => {
  const { serverlessInvoker } = await import("../dist/remote/serverless-workspace.js");
  const seen = [];
  const url = await startDouble(t, (request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, contentType: request.headers["content-type"], body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: 42 }));
    });
  });
  const invoke = serverlessInvoker(5000);

  const answer = await invoke(url, { function: "add", args: [40, 2] }, AbortSignal.timeout(5000));
  assert.equal(answer.ok, true);
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(JSON.parse(answer.body), { result: 42 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].contentType, "application/json");
  assert.deepEqual(seen[0].body, { function: "add", args: [40, 2] });
});

test("the real invoker never buffers past its byte cap, and reports a refusal by status", async (t) => {
  const { serverlessInvoker } = await import("../dist/remote/serverless-workspace.js");
  const big = "x".repeat(200_000);
  const url = await startDouble(t, (request, response) => {
    if (request.url === "/forbidden") { response.writeHead(403); response.end("no"); return; }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(big);
  });
  const invoke = serverlessInvoker(5000);

  const huge = await invoke(url, { function: "flood", args: [] }, AbortSignal.timeout(5000));
  assert.equal(huge.ok, true);
  assert.ok(huge.body.length <= 65536, "the response body is capped, whatever the function sends back");
  assert.ok(huge.body.length > 0);

  const refused = await invoke(`${url}/forbidden`, { function: "flood", args: [] }, AbortSignal.timeout(5000));
  assert.equal(refused.ok, false);
  assert.equal(refused.statusCode, 403);
});

test("the real invoker treats a dead address as an answerable failure, not a thrown error", async (t) => {
  const { serverlessInvoker } = await import("../dist/remote/serverless-workspace.js");
  const invoke = serverlessInvoker(2000);
  const result = await invoke("http://127.0.0.1:1", { function: "anything", args: [] }, AbortSignal.timeout(2000));
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 0);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
});
