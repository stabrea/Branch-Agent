import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, OpenAIProvider } from "../dist/index.js";
import { startTerminal } from "../dist/terminal.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for terminal fixture state");
}
async function fixture(t, provider, terminal = false) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-terminal-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), provider });
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const done = startTerminal(app.runtime, { input, output, signals, terminal, pollIntervalMs: 5 });
  t.after(async () => {
    if (!input.writableEnded) { input.write("/exit\n"); input.end(); }
    await done;
    await app.close();
    await discardTemp(root);
  });
  return { app, input, output, signals, done, text: () => text };
}

test("terminal streams live text/progress, interrupts a tool, and redirects the same persisted session", async (t) => {
  const firstReply = deferred(), toolStarted = deferred(), cleanup = deferred();
  t.after(() => { firstReply.resolve(); cleanup.resolve(); });
  let calls = 0, revisedMessages;
  const provider = {
    name: "terminal-fixture",
    async complete(request) {
      calls++;
      if (calls === 1) {
        request.onTextDelta?.("Working live");
        await firstReply.promise;
        return { content: "Working live", toolCalls: [{ id: "blocked", name: "fixture.block", arguments: '{"secret":"ARG_SECRET"}' }] };
      }
      revisedMessages = request.messages;
      return { content: calls === 2 ? "Revised task finished" : "Fresh session finished", toolCalls: [] };
    },
  };
  const f = await fixture(t, provider);
  f.app.registry.register({
    name: "fixture.block", permission: "fixture", description: "Interruptible fixture",
    parameters: z.object({ secret: z.string() }),
    async execute(_args, context) {
      toolStarted.resolve();
      await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      await cleanup.promise;
      throw context.signal.reason;
    },
  });
  f.input.write("Initial task\n");
  await until(() => f.text().includes("Working live"));
  assert.match(f.text(), /model.started/);
  assert.doesNotMatch(f.text(), /final assistant response/);
  assert.equal(f.app.store.runs("local")[0].status, "running");
  firstReply.resolve();
  await toolStarted.promise;
  await until(() => f.text().includes("tool.started fixture.block"));
  f.signals.emit("SIGINT");
  f.input.write("Revised task\n");
  await delay(25);
  assert.equal(calls, 1, "redirect waits for cancelled tool cleanup");
  cleanup.resolve();
  await until(() => f.text().includes("Revised task finished"));
  const runs = f.app.store.runs("local");
  const initial = runs.find((run) => run.prompt === "Initial task");
  const revised = runs.find((run) => run.prompt === "Revised task");
  assert.equal(initial.status, "cancelled");
  assert.equal(revised.status, "completed");
  assert.equal(revised.sessionId, initial.sessionId);
  assert.equal(JSON.parse(revisedMessages.find((message) => message.role === "tool").content).outcome, "unknown");
  assert.match(f.text(), /interrupted tool outcome unknown/);
  assert.doesNotMatch(f.text(), /ARG_SECRET/);
  f.input.write("/new\n");
  f.input.write("Fresh task\n");
  await until(() => f.text().includes("Fresh session finished"));
  const fresh = f.app.store.runs("local").find((run) => run.prompt === "Fresh task");
  assert.notEqual(fresh.sessionId, initial.sessionId);
  assert.deepEqual(revisedMessages.filter((message) => message.role === "user").map((message) => message.content), ["Fresh task"]);
  f.input.write("/exit\n");
  await f.done;
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("progress excludes raw tool results and provider errors; EOF settles work", async (t) => {
  let calls = 0;
  const provider = {
    name: "nonstreaming-fixture",
    async complete() {
      if (++calls === 1) return { content: "", toolCalls: [{ id: "safe", name: "fixture.secret", arguments: "{}" }] };
      throw new Error("PROVIDER_SECRET");
    },
  };
  const f = await fixture(t, provider);
  f.app.registry.register({ name: "fixture.secret", permission: "fixture", description: "Fixture", parameters: z.object({}),
    execute: async () => ({ token: "RESULT_SECRET" }) });
  f.input.end("Check secret fixture\n");
  await f.done;
  assert.match(f.text(), /tool.completed fixture.secret/);
  assert.match(f.text(), /model.failed/);
  assert.match(f.text(), /task failed/);
  assert.doesNotMatch(f.text(), /RESULT_SECRET|PROVIDER_SECRET|partial assistant text/);
  assert.equal(f.app.store.runs("local")[0].status, "failed");
});

test("typing a revision cancels an active model and /exit cleans up signal handlers", async (t) => {
  let calls = 0;
  const provider = {
    name: "cancel-model-fixture",
    async complete(request) {
      if (++calls === 1) return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return { content: "redirected", toolCalls: [] };
    },
  };
  const f = await fixture(t, provider);
  f.input.write("First\n");
  await until(() => calls === 1);
  f.input.write("Replacement\n");
  await until(() => f.text().includes("redirected"));
  assert.equal(new Set(f.app.store.runs("local").map((run) => run.sessionId)).size, 1);
  f.input.write("/exit\n");
  await f.done;
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("readline Ctrl+C keeps the terminal open for a same-session revision", async (t) => {
  let calls = 0;
  const provider = { name: "readline-fixture", async complete(request) {
    if (++calls === 1) return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    return { content: "Continued after Ctrl+C", toolCalls: [] };
  } };
  const f = await fixture(t, provider, true);
  f.input.write("First task\n");
  await until(() => calls === 1);
  f.input.write("\u0003");
  await until(() => f.text().includes("task cancelled"));
  f.input.write("Continue here\n");
  await until(() => f.text().includes("Continued after Ctrl+C"));
  assert.equal(new Set(f.app.store.runs("local").map((run) => run.sessionId)).size, 1);
  f.input.write("/exit\n");
  await f.done;
});

test("terminal shows real provider retry progress without printing private error bodies", async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before replying. */ }
    if (++requests === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "PRIVATE_RETRY_DETAIL" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"Recovered response"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = new OpenAIProvider({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "retry-fixture", apiKey: "FIXTURE_RETRY_KEY" });
  const f = await fixture(t, provider);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  f.input.end("Recover from a temporary failure\n");
  await f.done;
  assert.equal(requests, 2);
  assert.match(f.text(), /provider temporarily unavailable; retry 1\/2 in 250 ms/);
  assert.match(f.text(), /Recovered response/);
  assert.doesNotMatch(f.text(), /PRIVATE_RETRY_DETAIL|FIXTURE_RETRY_KEY/);
  assert.equal(f.app.store.runs("local")[0].status, "completed");
});
