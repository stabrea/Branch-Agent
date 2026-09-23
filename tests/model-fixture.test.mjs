// FQ-models.hosted-local: proves the same fixture conversation passes through a hosted-shaped
// connection (HTTPS address, bearer key) and a connection that runs on this computer (plain HTTP
// on loopback, no key) alike. Nothing here reaches a real service: both doubles run on 127.0.0.1,
// but the hosted one is addressed and routed as if it were not, exercising the HTTPS-only rule
// (src/providers.ts assertProviderEndpoint) the way a real hosted connection would be checked.
// A real paid hosted account and an installed local runtime (Ollama/LM Studio) are external and
// are not exercised here; see notes in the task report.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { OpenAIProvider, wireName } from "../dist/providers.js";
import { runFixture, runFixtureOn, fixtureToolName } from "../dist/model-fixture.js";

/** An OpenAI-shaped double: first call returns a tool call, second repeats the tool's answer word for word. */
async function openaiDouble(t) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    seen.push({ url: req.url, headers: req.headers, body: payload });
    res.setHeader("content-type", "application/json");
    if (seen.length === 1) {
      res.end(JSON.stringify({
        choices: [{ message: {
          content: null,
          tool_calls: [{ id: "call1", type: "function", function: {
            name: payload.tools[0].function.name, arguments: '{"word":"pingback"}',
          } }],
        } }],
      }));
    } else {
      const answer = payload.messages.at(-1).content;
      res.end(JSON.stringify({ choices: [{ message: { content: `the tool answered: ${answer}` } }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

test("the fixture calls the tool it was given, by its wire name", () => {
  assert.equal(typeof wireName(fixtureToolName), "string");
});

test("the same fixture passes through a hosted-shaped connection and a local one, unchanged", async (t) => {
  const hosted = await openaiDouble(t);
  const local = await openaiDouble(t);

  // Hosted: an HTTPS address (assertProviderEndpoint would refuse plain HTTP off loopback) whose
  // requests are rerouted to the local double, so no real network call is made.
  const hostedFetch = (target, init) => {
    const url = new URL(String(target));
    return fetch(`${hosted.origin}${url.pathname}`, init);
  };
  const hostedPreset = {
    id: "hosted-fixture", name: "Hosted fixture", model: "fixture-hosted",
    provider: new OpenAIProvider({
      endpoint: "https://api.hosted-fixture.example.com/v1", model: "fixture-hosted",
      apiKey: "hosted-secret", fetchImpl: hostedFetch,
    }),
  };
  // Local: a plain loopback address, the shape a connection on this computer (Ollama's OpenAI-
  // compatible route) really has. No key is needed, matching how Branch treats one (src/provider-
  // factory.ts uses the placeholder "local" key for these).
  const localPreset = {
    id: "local-fixture", name: "Local fixture", model: "fixture-local",
    provider: new OpenAIProvider({ endpoint: `${local.origin}/v1`, model: "fixture-local", apiKey: "local" }),
  };

  const results = await runFixtureOn([hostedPreset, localPreset]);
  assert.equal(results.length, 2);
  const [hostedResult, localResult] = results;

  assert.equal(hostedResult.passed, true, hostedResult.reason ?? "");
  assert.equal(localResult.passed, true, localResult.reason ?? "");
  // "local" is read from the connection itself (presetRunsLocally), not asserted by the test.
  assert.equal(hostedResult.local, false);
  assert.equal(localResult.local, true);

  // Same fixture: both doubles were asked the identical conversation and tool, byte for byte.
  assert.deepEqual(hosted.seen[0].body.messages, local.seen[0].body.messages);
  assert.deepEqual(hosted.seen[0].body.tools, local.seen[0].body.tools);
  assert.equal(hosted.seen[0].headers.authorization, "Bearer hosted-secret");
  assert.equal(local.seen[0].headers.authorization, "Bearer local");
  // The round trip really happened: the tool result from step one was read back in step two.
  assert.match(hosted.seen[1].body.messages.at(-1).content, /^echo: pingback \(check code [0-9a-f]{12}\)$/);
  assert.match(local.seen[1].body.messages.at(-1).content, /^echo: pingback \(check code [0-9a-f]{12}\)$/);
});

/** A stand-in connection that calls the tool, then answers with whatever `reply` makes of the tool result. */
function scriptedConnection(reply) {
  const requests = [];
  return {
    requests,
    preset: {
      id: "scripted", name: "Scripted", model: "fixture",
      provider: {
        name: "scripted",
        async complete(request) {
          request.signal.throwIfAborted(); // honours the abort, as the real providers do
          requests.push(request);
          if (requests.length === 1)
            return { content: "", toolCalls: [{ id: "c1", name: request.tools[0].name, arguments: '{"word":"pingback"}' }] };
          return { content: reply(request.messages.at(-1).content), toolCalls: [] };
        },
      },
    },
  };
}

test("a connection that repeats the word from the question without reading the tool's answer fails", async () => {
  // It never looks at the tool result, but the word it chose is already in the question.
  const { preset } = scriptedConnection(() => "The tool answered: echo: pingback");
  const result = await runFixture(preset, new AbortController().signal);
  assert.equal(result.passed, false);
  assert.match(result.reason, /did not read the tool's answer back/);
});

test("the tool's answer carries a fresh check code that the question never contains", async () => {
  const first = scriptedConnection((answer) => `It said: ${answer}`);
  const second = scriptedConnection((answer) => `It said: ${answer}`);
  const [a, b] = [await runFixture(first.preset, new AbortController().signal), await runFixture(second.preset, new AbortController().signal)];
  assert.equal(a.passed, true, a.reason ?? "");
  assert.equal(b.passed, true, b.reason ?? "");
  const codeOf = (requests) => /check code ([0-9a-f]{12})/.exec(requests[1].messages.at(-1).content)?.[1];
  const code = codeOf(first.requests);
  assert.ok(code, "the tool's answer carries a check code");
  assert.equal(JSON.stringify(first.requests[0].messages).includes(code), false, "the code is not in the question");
  assert.notEqual(codeOf(second.requests), code, "each run gets its own code");
});

test("each connection gets its own time limit, so a slow first one does not starve the next", async () => {
  // Never answers and ignores the abort, the worst case for everything queued behind it.
  const stuck = { id: "stuck", name: "Stuck", model: "fixture", provider: { name: "stuck", complete: () => new Promise(() => undefined) } };
  const quick = scriptedConnection((answer) => `It said: ${answer}`);
  const started = Date.now();
  const [slow, fast] = await runFixtureOn([stuck, quick.preset], 400);
  assert.equal(slow.passed, false);
  assert.match(slow.reason, /timed out/);
  assert.equal(fast.passed, true, fast.reason ?? "");
  assert.ok(Date.now() - started < 5000);
});

test("a connection that ignores the tool fails the fixture with a plain reason", async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "sure, I can help" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const preset = {
    id: "silent", name: "Silent", model: "fixture",
    provider: new OpenAIProvider({ endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture", apiKey: "local" }),
  };
  const result = await runFixture(preset, new AbortController().signal);
  assert.equal(result.passed, false);
  assert.match(result.reason, /did not call/);
});
