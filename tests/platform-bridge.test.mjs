import test from "node:test";
import assert from "node:assert/strict";
import {
  DifyAccess, N8nAccess, PlatformBridgeAccess, registerPlatformBridge,
  makeHandle, readHandle, DifyConfigSchema, N8nConfigSchema,
} from "../dist/integrations/platform-bridge.js";
import { NetworkPolicy } from "../dist/index.js";
import { ToolRegistry } from "../dist/registry.js";
import { PlatformsConfigSchema } from "../dist/integrations/bootstrap.js";

/* FQ-extensions.platform-bridge: connectors to hosted workflow platforms (Dify, n8n), with the
 * run id each hands back correlated to the right connector so a status check never lands on the
 * wrong platform's run. Every request is a stand-in for the real service. */
const open = () => new NetworkPolicy({ allowPrivateAddresses: true });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

/**
 * A fake Dify and a fake n8n server sharing one fetch stub, each tracking a run under the id "42" —
 * on purpose, so a test that mixes the two up would see the wrong platform's answer.
 */
function fakeServers(calls) {
  const fetchImpl = async (url, init) => {
    const address = String(url);
    calls.push({ url: address, headers: init.headers, body: init.body });
    if (address === "https://dify.example/v1/workflows/run" && init.method === "POST")
      return json({ task_id: "42", workflow_run_id: "wr-42", data: { status: "succeeded", outputs: { answer: "dify-answer" } } });
    if (address === "https://dify.example/v1/workflows/run/42")
      return json({ status: "succeeded", outputs: { answer: "dify-answer" } });
    if (address === "https://n8n.example/webhook/my-flow" && init.method === "POST")
      return json({ executionId: "42" });
    if (address === "https://n8n.example/api/v1/executions/42")
      return json({ finished: true, status: "success" });
    return json({ message: "not found" }, 404);
  };
  const dify = new DifyAccess({ apiBase: "https://dify.example/v1" }, open(), async () => "dify-SECRET", fetchImpl);
  const n8n = new N8nAccess({ apiBase: "https://n8n.example" }, open(), async () => "n8n-SECRET", fetchImpl);
  return { dify, n8n, calls };
}

test("platform-bridge: a trigger on each platform gets back a run correlated to that platform, never the other's", async () => {
  const { dify, n8n, calls } = fakeServers([]);
  const bridge = new PlatformBridgeAccess({ dify, n8n });
  assert.deepEqual(bridge.available(), ["dify", "n8n"]);

  const [difyRun, n8nRun] = await Promise.all([
    bridge.trigger({ platform: "dify", workflowId: "support-triage", inputs: { ticket: "T-1" } }),
    bridge.trigger({ platform: "n8n", workflowId: "my-flow", inputs: { order: "O-1" } }),
  ]);
  // Both platforms happen to hand back the raw id "42"; the handles must not collide.
  assert.equal(difyRun.handle, "dify:42");
  assert.equal(n8nRun.handle, "n8n:42");
  assert.notEqual(difyRun.handle, n8nRun.handle);
  assert.equal(difyRun.status, "succeeded");
  assert.deepEqual(difyRun.outputs, { answer: "dify-answer" });
  assert.equal(n8nRun.status, "running", "n8n's webhook only confirms the run started");

  // Checking status by the handle each trigger returned reaches the right platform and the right run.
  const difyStatus = await bridge.status(difyRun.handle);
  const n8nStatus = await bridge.status(n8nRun.handle);
  assert.equal(difyStatus.platform, "dify");
  assert.deepEqual(difyStatus.outputs, { answer: "dify-answer" });
  assert.equal(n8nStatus.platform, "n8n");
  assert.equal(n8nStatus.status, "succeeded");

  assert.ok(calls.some((call) => call.url === "https://dify.example/v1/workflows/run/42"));
  assert.ok(calls.some((call) => call.url === "https://n8n.example/api/v1/executions/42"));
  // The n8n status read carries the API key; the webhook trigger, which needs none, does not.
  const executionCall = calls.find((call) => call.url.includes("executions/42"));
  assert.equal(executionCall.headers["X-N8N-API-KEY"], "n8n-SECRET");
  const webhookCall = calls.find((call) => call.url === "https://n8n.example/webhook/my-flow");
  assert.equal(webhookCall.headers["X-N8N-API-KEY"], undefined, "the trigger webhook needs no key, only the status read does");
  assert.equal(calls.every((call) => !call.url.includes("SECRET")), true, "a key never travels in an address");
});

test("platform-bridge: a handle names its platform, so a bare or foreign id is refused rather than guessed at", async () => {
  const { dify, n8n } = fakeServers([]);
  const bridge = new PlatformBridgeAccess({ dify, n8n });
  await assert.rejects(bridge.status("42"), /not a run handle this bridge gave out/);
  await assert.rejects(bridge.status("slack:42"), /not a run handle this bridge gave out/);
  await assert.rejects(bridge.status(""), /not a run handle this bridge gave out/);
  assert.deepEqual(readHandle(makeHandle("dify", "9")), { platform: "dify", taskId: "9" });

  const difyOnly = new PlatformBridgeAccess({ dify });
  assert.deepEqual(difyOnly.available(), ["dify"]);
  await assert.rejects(difyOnly.trigger({ platform: "n8n", workflowId: "x", inputs: {} }), /n8n is not set up/);
  await assert.rejects(difyOnly.status("n8n:1"), /n8n is not set up/);
});

test("platform-bridge: the saved key travels only in the request, and a failed run and a refused key answer in words", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).endsWith("/workflows/run")) return json({ message: "dify-SECRET leaked here" }, 401);
    return json({});
  };
  const dify = new DifyAccess({ apiBase: "https://dify.example/v1" }, open(), async () => "dify-SECRET", fetchImpl);
  await assert.rejects(
    dify.trigger({ workflowId: "w", inputs: {} }),
    (error) => {
      assert.match(error.message, /did not accept the key/);
      assert.equal(error.message.includes("dify-SECRET"), false, "the key is scrubbed even out of Dify's own echo");
      return true;
    },
  );
  assert.equal(calls[0].headers.authorization, "Bearer dify-SECRET");

  const missingId = new DifyAccess({ apiBase: "https://dify.example/v1" }, open(), async () => "k",
    async () => json({ data: { status: "succeeded" } }));
  await assert.rejects(missingId.trigger({ workflowId: "w", inputs: {} }), /did not send back a task id/);

  const noExecutionId = new N8nAccess({ apiBase: "https://n8n.example" }, open(), async () => "k",
    async () => json({ ok: true }));
  await assert.rejects(noExecutionId.trigger({ workflowId: "my-flow", inputs: {} }), /Respond to Webhook/);

  const errored = new N8nAccess({ apiBase: "https://n8n.example" }, open(), async () => "k", async (url) =>
    String(url).includes("executions") ? json({ finished: true, status: "error", data: { resultData: { error: "boom" } } }) : json({ executionId: "5" }));
  const started = await errored.trigger({ workflowId: "my-flow", inputs: {} });
  const status = await errored.status(readHandle(started.handle).taskId);
  assert.equal(status.status, "failed");
  assert.equal(status.error, "boom");
});

test("platform-bridge: settings default sensibly, n8n always needs its own address, and each connector needs a saved key", () => {
  const dify = DifyConfigSchema.parse({});
  assert.equal(dify.apiBase, "https://api.dify.ai/v1");
  assert.equal(dify.tokenSecret, "DIFY_API_KEY");
  assert.throws(() => N8nConfigSchema.parse({}), /apiBase|Required|invalid_type/i, "n8n is always self-hosted; there is no default address");
  const n8n = N8nConfigSchema.parse({ apiBase: "https://n8n.example" });
  assert.equal(n8n.tokenSecret, "N8N_API_KEY");

  const parsed = PlatformsConfigSchema.parse({ dify: {}, n8n: { apiBase: "https://n8n.example" } });
  assert.equal(parsed.dify.tokenSecret, "DIFY_API_KEY", "Dify's defaults fill in even through the partial settings schema");
  assert.equal(parsed.n8n.apiBase, "https://n8n.example");
  assert.equal(PlatformsConfigSchema.parse({}).dify, undefined, "off until named in the settings, same as every other tracker");
});

test("platform-bridge: the two tools are registered read/write apart, and only once the platforms need them", () => {
  const { dify, n8n } = fakeServers([]);
  const registry = new ToolRegistry();
  registerPlatformBridge(registry, new PlatformBridgeAccess({ dify, n8n }));
  assert.deepEqual(registry.names().sort(), ["platforms.status", "platforms.trigger"]);
  assert.equal(registry.permissionOf("platforms.trigger"), "platforms.run");
  assert.equal(registry.permissionOf("platforms.status"), "platforms.read");
});
