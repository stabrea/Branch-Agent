import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  OpenAIProvider,
  AnthropicProvider,
  providerFromEnv,
} from "../dist/providers.js";

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: payload });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(handler(payload, requests.length)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
const request = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "read" },
  ],
  tools: [
    {
      name: "files.read",
      description: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
  signal: new AbortController().signal,
  maxTokens: 100,
};

test("OpenAI protocol maps tool names/results and records reported usage", async (t) => {
  const { endpoint, requests } = await fixture(t, (body, n) =>
    n === 1
      ? {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call1",
                    type: "function",
                    function: {
                      name: body.tools[0].function.name,
                      arguments: '{"path":"x"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 12 },
        }
      : {
          choices: [{ message: { content: "read complete" } }],
          usage: { prompt_tokens: 60, completion_tokens: 3 },
        },
  );
  const provider = new OpenAIProvider({
    endpoint,
    model: "fixture-model",
    apiKey: "fixture-key",
  });
  const first = await provider.complete(request);
  assert.equal(first.toolCalls[0].name, "files.read");
  assert.deepEqual(first.usage, { input: 50, output: 12 });
  const next = await provider.complete({
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: "", toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "call1", content: "hello" },
    ],
  });
  assert.equal(next.content, "read complete");
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, "call1");
  assert.equal(requests[0].headers.authorization, "Bearer fixture-key");
  assert.equal(requests[0].url, "/v1/chat/completions");
});

test("Anthropic protocol translates tool_use and tool_result blocks", async (t) => {
  const { endpoint, requests } = await fixture(t, (body, n) =>
    n === 1
      ? {
          content: [
            { type: "text", text: "Reading" },
            {
              type: "tool_use",
              id: "call1",
              name: body.tools[0].name,
              input: { path: "x" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 8 },
        }
      : {
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 25, output_tokens: 2 },
        },
  );
  const provider = new AnthropicProvider({
    endpoint,
    model: "fixture-model",
    apiKey: "fixture-key",
  });
  const first = await provider.complete(request);
  assert.equal(first.toolCalls[0].name, "files.read");
  await provider.complete({
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "call1", content: "hello" },
    ],
  });
  assert.equal(
    requests[1].body.messages.at(-1).content[0].tool_use_id,
    "call1",
  );
  assert.equal(requests[0].body.system, "system");
  assert.equal(requests[0].headers["x-api-key"], "fixture-key");
});

test("malformed provider responses fail validation", async (t) => {
  const { endpoint } = await fixture(t, () => ({
    choices: [
      {
        message: {
          tool_calls: [
            { id: "x", function: { name: "missing", arguments: 42 } },
          ],
        },
      },
    ],
  }));
  await assert.rejects(
    new OpenAIProvider({ endpoint, model: "fixture", apiKey: "x" }).complete(
      request,
    ),
  );
});

test("real provider configuration is explicit and has no credential fallback", () => {
  assert.equal(providerFromEnv({}).name, "offline-demo-fixture");
  assert.throws(
    () => providerFromEnv({ BRANCH_PROVIDER: "openai" }),
    /BRANCH_/,
  );
  assert.throws(
    () =>
      new OpenAIProvider({
        endpoint: "http://example.com",
        model: "m",
        apiKey: "k",
      }),
    /HTTPS/,
  );
});
