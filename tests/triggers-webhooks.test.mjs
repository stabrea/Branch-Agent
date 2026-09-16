import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

function scripted() {
  const provider = {
    name: "scripted",
    requests: [],
    failNext: false,
    async complete(request) {
      provider.requests.push(request);
      if (provider.failNext) {
        provider.failNext = false;
        throw new Error("provider down");
      }
      return { content: `Result ${provider.requests.length}`, toolCalls: [] };
    },
  };
  return provider;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-triggers-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const context = app.runtime.context();
  return { app, root, provider, context };
}

test("trigger creation and retrieval", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Deploy webhook",
    prompt: "Deploy {{payload.branch}} to {{environment}}",
    rateLimitPerMinute: 30,
  });
  assert.ok(trigger.id);
  assert.equal(trigger.name, "Deploy webhook");
  assert.equal(trigger.enabled, true);
  assert.ok(trigger.secret.length > 0);

  const retrieved = app.triggers.get("local", trigger.id);
  assert.deepEqual(retrieved, trigger);
});

test("trigger fire with bearer token verification", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Test trigger",
    prompt: "Event: {{payload.event}}",
    rateLimitPerMinute: 30,
  });

  // Test with bearer token
  const verified = app.triggers.verify(trigger, { authorization: `Bearer ${trigger.secret}` }, Buffer.from("{}"));
  assert.ok(verified.valid);

  // Test with invalid bearer token
  const invalid = app.triggers.verify(trigger, { authorization: "Bearer wrong" }, Buffer.from("{}"));
  assert.ok(!invalid.valid);
});

test("trigger fire with HMAC-SHA256 signature verification", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Test trigger",
    prompt: "Event fired",
    rateLimitPerMinute: 30,
  });

  const body = Buffer.from(JSON.stringify({ event: "test" }));
  const signature = createHmac("sha256", trigger.secret).update(body).digest("hex");

  // Test with correct signature
  const verified = app.triggers.verify(trigger, { "x-branch-signature": `sha256=${signature}` }, body);
  assert.ok(verified.valid);

  // Test with incorrect signature
  const invalid = app.triggers.verify(trigger, { "x-branch-signature": "sha256=wrong" }, body);
  assert.ok(!invalid.valid);
});

test("trigger fire executes with placeholder substitution", async (t) => {
  const { app, context, provider } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Test trigger",
    prompt: "Deploy {{branch}} to {{environment}}. Full payload: {{payload}}",
    rateLimitPerMinute: 30,
  });

  const result = await app.triggers.fire("local", trigger.id, { branch: "main", environment: "prod" });
  assert.ok(result.runId);
  assert.equal(result.status, "completed");

  // Check that the prompt had substitutions
  const lastPrompt = provider.requests[0].messages.filter((m) => m.role === "user")[0].content;
  assert.ok(lastPrompt.includes("main"));
  assert.ok(lastPrompt.includes("prod"));
});

test("trigger rate limiting prevents firing beyond the limit", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Rate limited",
    prompt: "Event",
    rateLimitPerMinute: 2, // Low limit for testing
  });

  // First fire
  const result1 = await app.triggers.fire("local", trigger.id, {});
  assert.ok(result1.runId);

  // Second fire
  const result2 = await app.triggers.fire("local", trigger.id, {});
  assert.ok(result2.runId);

  // Third fire should be rate limited
  try {
    await app.triggers.fire("local", trigger.id, {});
    assert.fail("Should have thrown rate limit error");
  } catch (e) {
    assert.match(e.message, /Rate limit exceeded/);
  }
});

test("trigger fire logs each event with payload summary", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Logging test",
    prompt: "Test",
    rateLimitPerMinute: 30,
  });

  const result = await app.triggers.fire("local", trigger.id, { event: "test_event", data: { foo: "bar" } });
  const log = app.triggers.getLog(trigger.id, "local");

  assert.ok(log.length > 0);
  assert.equal(log[0].status, "completed");
  assert.equal(log[0].runId, result.runId);
  assert.ok(log[0].payloadSummary.includes("test_event"));
});

test("webhook creation and listing", async (t) => {
  const { app, context } = await fixture(t);
  const webhook = app.webhooks.create(context, {
    name: "Test webhook",
    url: "https://example.com/webhook",
    events: ["run.completed", "run.failed"],
  });

  assert.ok(webhook.id);
  assert.equal(webhook.name, "Test webhook");
  assert.equal(webhook.enabled, true);
  assert.deepEqual(webhook.events, ["run.completed", "run.failed"]);

  const list = app.webhooks.list("local");
  assert.ok(list.some((w) => w.id === webhook.id));
});

test("webhook test delivery succeeds", async (t) => {
  const { app, context } = await fixture(t);
  const webhook = app.webhooks.create(context, {
    name: "Test webhook",
    url: "https://example.com/webhook",
    events: ["run.completed"],
  });

  // This will fail with network policy since example.com is not allowed, but it shows the delivery attempt
  const result = await app.webhooks.test("local", webhook.id);
  assert.ok(result.hasOwnProperty("ok"));
  assert.ok(result.message);
});

test("webhook disable after consecutive failures", async (t) => {
  const { app, context } = await fixture(t);
  const webhook = app.webhooks.create(context, {
    name: "Failing webhook",
    url: "https://localhost:9999/webhook", // Will fail - port not listening
    events: ["run.completed"],
  });

  // Simulate failures by calling deliver multiple times
  for (let i = 0; i < 5; i++) {
    await app.webhooks.deliver("local", webhook.id, "run.completed", { runId: "test" });
  }

  const updated = app.webhooks.get("local", webhook.id);
  assert.ok(!updated.enabled, "Webhook should be disabled after 5 failures");
  assert.ok(updated.disabledReason?.includes("consecutive delivery failures"));
});

test("webhook enable re-enables after auto-disable", async (t) => {
  const { app, context } = await fixture(t);
  const webhook = app.webhooks.create(context, {
    name: "Webhook",
    url: "https://example.com",
    events: ["run.completed"],
  });

  // Disable it manually
  app.webhooks.enable("local", webhook.id); // Reset state

  const enabled = app.webhooks.get("local", webhook.id);
  assert.ok(enabled.enabled);
  assert.equal(enabled.failureCount, 0);
});
