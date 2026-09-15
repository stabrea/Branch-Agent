import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-core-"));
  const options = {
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  };
  const app = await createBranch(options);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, options };
}
function assertValidTranscript(messages) {
  let pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") {
      assert.ok(
        pending.delete(message.toolCallId),
        "Tool reply must match a pending call",
      );
      continue;
    }
    assert.equal(
      pending.size,
      0,
      "Assistant tool calls must all have replies before the next message",
    );
    if (message.role === "assistant")
      pending = new Set((message.toolCalls ?? []).map((call) => call.id));
  }
  assert.equal(pending.size, 0);
}
const oneCall = {
  content: "",
  toolCalls: [
    {
      id: "pending-call",
      name: "files.write",
      arguments: '{"path":"should-not-replay.txt","content":"side effect"}',
    },
  ],
};

test("budget termination repairs pending tool replies before the same session continues", async (t) => {
  let calls = 0;
  const { app } = await fixture(t, {
    name: "strict-protocol-fixture",
    async complete({ messages }) {
      assertValidTranscript(messages);
      return ++calls === 1 ? oneCall : { content: "continued", toolCalls: [] };
    },
  });
  const first = await app.runtime.run({
    prompt: "write",
    budget: { maxSteps: 1, maxTokens: 20000 },
  });
  assert.equal(first.status, "budget_exceeded");
  assertValidTranscript(app.store.messages(first.sessionId));
  const reply = app.store
    .messages(first.sessionId)
    .find((message) => message.role === "tool");
  assert.equal(JSON.parse(reply.content).outcome, "unknown");
  const next = await app.runtime.run({
    prompt: "continue safely",
    sessionId: first.sessionId,
  });
  assert.equal(next.status, "completed");
  assert.equal(next.output, "continued");
  await assert.rejects(app.files.read("should-not-replay.txt"), /ENOENT/);
});

test("startup reconciles crash-interrupted batches once without replaying side effects", async (t) => {
  const { app, options } = await fixture(t, {
    name: "strict-protocol-fixture",
    async complete({ messages }) {
      assertValidTranscript(messages);
      return { content: "recovered", toolCalls: [] };
    },
  });
  const run = app.store.createRun("local", "crash");
  app.store.message(run.sessionId, { role: "user", content: "crash" });
  app.store.message(run.sessionId, {
    role: "assistant",
    content: "",
    toolCalls: [
      ...oneCall.toolCalls,
      { ...oneCall.toolCalls[0], id: "already-done" },
    ],
  });
  app.store.message(run.sessionId, {
    role: "tool",
    toolCallId: "already-done",
    content: '{"ok":true}',
  });
  app.store.message(run.sessionId, {
    role: "user",
    content: "A previous version allowed this unmatched continuation",
  });
  await app.close();
  const reopened = await createBranch(options);
  assertValidTranscript(reopened.store.messages(run.sessionId));
  const recovered = await reopened.runtime.run({
    prompt: "continue",
    sessionId: run.sessionId,
  });
  assert.equal(recovered.status, "completed");
  const count = reopened.store.messages(run.sessionId).length;
  await reopened.close();
  const again = await createBranch(options);
  assert.equal(again.store.messages(run.sessionId).length, count);
  await assert.rejects(again.files.read("should-not-replay.txt"), /ENOENT/);
  await again.close();
});

test("repeated promotion preserves the previous active specialist for rollback", async (t) => {
  const { app } = await fixture(t),
    context = app.runtime.context();
  const definition = {
    name: "helper",
    instructions: "Demo",
    permissions: ["files.read", "files.write"],
    evaluation: {
      prompt: "demo",
      checks: [{ path: "branch-demo.txt", expected: "Hello from Branch.\n" }],
    },
  };
  const candidate = app.knowledge.proposeSpecialist(context, definition);
  await app.knowledge.evaluateSpecialist(context, candidate.id);
  app.knowledge.promoteSpecialist(context, candidate.id);
  app.knowledge.proposeSpecialist(context, { ...definition, id: candidate.id });
  await app.knowledge.evaluateSpecialist(context, candidate.id);
  app.knowledge.promoteSpecialist(context, candidate.id);
  app.knowledge.promoteSpecialist(context, candidate.id);
  assert.equal(
    app.knowledge.rollbackSpecialist(context, candidate.id).data.activeVersion,
    1,
  );
});

test("saturated execution slots still allow status and cancellation", async (t) => {
  let started = 0,
    allStarted;
  const ready = new Promise((resolve) => {
    allStarted = resolve;
  });
  const provider = {
    name: "blocking-fixture",
    async complete({ signal }) {
      if (++started === 8) allStarted();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return { content: "unused", toolCalls: [] };
    },
  };
  const { app, options } = await fixture(t, provider),
    server = await startServer(app, { dataDir: options.dataDir, port: 0 });
  const headers = {
    authorization: "Bearer " + server.token,
    "content-type": "application/json",
  };
  const requests = Array.from({ length: 8 }, (_, i) =>
    fetch(server.url + "/api/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "wait " + i }),
    }),
  );
  try {
    await ready;
    const overflow = await fetch(server.url + "/api/run", {
      method: "POST",
      headers,
      body: '{"prompt":"ninth"}',
    });
    assert.equal(overflow.status, 429);
    const state = await fetch(server.url + "/api/state", { headers });
    assert.equal(state.status, 200);
    const id = (await state.json()).runs[0].id;
    const cancel = await fetch(server.url + "/api/runs/" + id + "/cancel", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).cancelled, true);
  } finally {
    await server.close();
    await Promise.allSettled(requests);
  }
});

test("cleanup failures cannot leave completed status while rejecting the run", async (t) => {
  const { app } = await fixture(t, {
    name: "fixture",
    async complete() {
      return { content: "work result", toolCalls: [] };
    },
  });
  app.registry.onRunFinished(async () => {
    throw new Error("cleanup fixture failure");
  });
  const run = await app.runtime.run({ prompt: "work" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /cleanup/i);
  assert.equal(app.store.run(run.id).status, "failed");
  assert.ok(
    app.store
      .events(run.id)
      .some((event) => event.kind === "run.cleanup_failed"),
  );
  await assert.rejects(
    app.runtime.executeTool("memory.put", {
      text: "saved before cleanup",
      source: "test",
    }),
    /cleanup/i,
  );
  assert.ok(
    app.store.runs("local").every((record) => record.status === "failed"),
  );
});

test("runtime shutdown waits for run cleanup to drain", async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    drain = new Promise((resolve) => {
      release = resolve;
    });
  const { app } = await fixture(t, {
    name: "fixture",
    async complete() {
      return { content: "done", toolCalls: [] };
    },
  });
  app.registry.onRunFinished(async () => {
    entered();
    await drain;
  });
  const pending = app.runtime.run({ prompt: "finish" });
  await ready;
  let shutdownDone = false;
  const shutdown = app.runtime.shutdown().then(() => {
    shutdownDone = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownDone, false);
  release();
  await Promise.all([pending, shutdown]);
  assert.equal(shutdownDone, true);
  await assert.rejects(app.runtime.run({ prompt: "too late" }), /shut/i);
});

test("cancelled tool side effects are marked unknown and never replayed on continuation", async (t) => {
  let calls = 0,
    sideEffects = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const provider = {
    name: "cancellation-protocol-fixture",
    async complete({ messages }) {
      assertValidTranscript(messages);
      return ++calls === 1
        ? {
            content: "",
            toolCalls: [
              { id: "cancelled-tool", name: "fixture.effect", arguments: "{}" },
              ...oneCall.toolCalls,
            ],
          }
        : { content: "continued safely", toolCalls: [] };
    },
  };
  const { app } = await fixture(t, provider);
  app.registry.register({
    name: "fixture.effect",
    description: "Controlled side effect fixture",
    permission: "fixture.effect",
    parameters: z.object({}),
    execute: async (_args, { signal }) => {
      sideEffects++;
      entered();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return {};
    },
  });
  const controller = new AbortController(),
    pending = app.runtime.run({ prompt: "effect", signal: controller.signal });
  await ready;
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assertValidTranscript(app.store.messages(cancelled.sessionId));
  const results = app.store
    .messages(cancelled.sessionId)
    .filter((message) => message.role === "tool");
  assert.equal(results.length, 2);
  assert.ok(
    results.every(
      (message) => JSON.parse(message.content).outcome === "unknown",
    ),
  );
  const continued = await app.runtime.run({
    prompt: "continue",
    sessionId: cancelled.sessionId,
  });
  assert.equal(continued.status, "completed");
  assert.equal(sideEffects, 1);
  await assert.rejects(app.files.read("should-not-replay.txt"), /ENOENT/);
});

test("invalid budgets do not create durable runs or active controllers", async (t) => {
  const { app } = await fixture(t);
  for (const budget of [
    { maxSteps: 0, maxTokens: 2000 },
    { maxSteps: 10, maxTokens: 0 },
  ]) {
    await assert.rejects(
      app.runtime.run({ prompt: "invalid budget", budget }),
      /Invalid budget/,
    );
    assert.equal(app.store.runs("local").length, 0);
  }
  await app.runtime.shutdown();
  assert.equal(app.store.runs("local").length, 0);
});

test("invalid budgets preserve an existing session for valid continuation", async (t) => {
  const { app } = await fixture(t, {
    name: "fixture",
    async complete() {
      return { content: "continued", toolCalls: [] };
    },
  });
  const initial = await app.runtime.run({ prompt: "begin" });
  const originalMessages = app.store.messages(initial.sessionId);
  for (const budget of [
    { maxSteps: 0, maxTokens: 2000 },
    { maxSteps: 10, maxTokens: 0 },
  ]) {
    await assert.rejects(
      app.runtime.run({
        prompt: "invalid",
        sessionId: initial.sessionId,
        budget,
      }),
      /Invalid budget/,
    );
    assert.equal(app.store.runs("local").length, 1);
    assert.deepEqual(app.store.messages(initial.sessionId), originalMessages);
  }
  const continued = await app.runtime.run({
    prompt: "valid",
    sessionId: initial.sessionId,
  });
  assert.equal(continued.status, "completed");
  assert.equal(app.store.runs("local").length, 2);
});
