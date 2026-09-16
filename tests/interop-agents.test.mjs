import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { AcpConnection } from "../dist/acp.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

/** A provider that answers deterministically, and can be told to call one tool first. */
function scripted() {
  const provider = {
    name: "scripted",
    toolCall: null,
    async complete(request) {
      request.signal.throwIfAborted();
      const alreadyCalled = request.messages.some((m) => m.role === "tool");
      if (provider.toolCall && !alreadyCalled)
        return { content: "", toolCalls: [{ id: "c1", name: provider.toolCall.name, arguments: JSON.stringify(provider.toolCall.args) }] };
      const user = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const words = `Echo: ${user.slice(0, 60)}`;
      request.onTextDelta?.(words.slice(0, 6));
      request.onTextDelta?.(words.slice(6));
      return { content: words, toolCalls: [] };
    },
  };
  return provider;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-interop-agents-"));
  const provider = scripted();
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    provider,
    web: { allowPrivateAddresses: true, ...(options.web ?? {}) },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const headers = (extra = {}) => ({ authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json", ...extra });
  const api = async (path, body, extra) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(extra),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const shareA2a = (on = true, exposedTools = []) => api("/api/mcp/settings", { enabled: on, exposedTools, a2a: on });
  const rpc = (method, params, extra) =>
    api("/a2a", { jsonrpc: "2.0", id: "t1", method, params }, extra);
  return { app, provider, server, api, headers, rpc, shareA2a };
}

// ---------------------------------------------------------------- A2A server

test("the agent card is hidden until the owner shares, then names what is shared", async (t) => {
  const { api, shareA2a } = await fixture(t);
  const closed = await api("/.well-known/agent.json");
  assert.equal(closed.status, 404, "nothing is advertised before the owner switches it on");
  await shareA2a(true, ["files.read"]);
  const open = await api("/.well-known/agent.json");
  assert.equal(open.status, 200);
  assert.equal(open.body.authentication.schemes[0], "bearer");
  assert.equal(open.body.capabilities.streaming, true);
  assert.match(open.body.url, /\/a2a$/);
  const ids = open.body.skills.map((skill) => skill.id);
  assert.ok(ids.includes("branch.ask"), "asking Branch is always offered");
  assert.ok(ids.includes("files.read"), "a shared tool becomes a skill");
  assert.ok(!ids.includes("files.write"), "a tool the owner did not share is not offered");
});

test("sharing with other assistants is off by default", async (t) => {
  const { api, rpc } = await fixture(t);
  const settings = await api("/api/mcp/settings");
  assert.equal(settings.body.a2a, false);
  assert.equal(settings.body.enabled, false);
  const refused = await rpc("tasks/send", { message: { role: "user", parts: [{ type: "text", text: "hello" }] } });
  assert.equal(refused.status, 404);
});

test("tasks/send makes a real task and answers with its artifact, and tasks/get finds it again", async (t) => {
  const { app, rpc, shareA2a } = await fixture(t);
  await shareA2a();
  const sent = await rpc("tasks/send", { id: "task-1", message: { role: "user", parts: [{ type: "text", text: "count the files" }] } });
  assert.equal(sent.status, 200);
  const task = sent.body.result;
  assert.equal(task.id, "task-1");
  assert.equal(task.status.state, "completed");
  assert.equal(task.artifacts.length, 1);
  assert.match(task.artifacts[0].parts[0].text, /count the files/);
  const run = app.store.run(task.metadata.runId);
  assert.ok(run, "the task is a real Branch task");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "a2a.task"), "who asked is recorded on the task");
  const fetched = await rpc("tasks/get", { id: "task-1" });
  assert.equal(fetched.body.result.metadata.runId, run.id);
  const missing = await rpc("tasks/get", { id: "task-never" });
  assert.equal(missing.body.error.code, -32001);
});

test("an attachment from outside is refused rather than read", async (t) => {
  const { rpc, shareA2a } = await fixture(t);
  await shareA2a();
  const sent = await rpc("tasks/send", { message: { role: "user", parts: [{ type: "file", file: { uri: "file:///etc/passwd" } }] } });
  assert.equal(sent.body.error.code, -32602);
  assert.match(sent.body.error.message, /written instructions only/);
});

test("tasks/sendSubscribe streams the steps and ends with the answer", async (t) => {
  const { server, headers, shareA2a } = await fixture(t);
  await shareA2a();
  const response = await fetch(`${server.url}/a2a`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tasks/sendSubscribe", params: { id: "stream-1", message: { role: "user", parts: [{ type: "text", text: "say hello" }] } } }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  const frames = text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
  assert.ok(frames.every((frame) => frame.jsonrpc === "2.0" && frame.id === 7));
  assert.equal(frames[0].result.status.state, "submitted");
  assert.ok(frames.some((frame) => frame.result.artifact), "the answer arrives as an artifact");
  const last = frames.at(-1).result;
  assert.equal(last.final, true);
  assert.equal(last.status.state, "completed");
});

test("a task that is still running can be cancelled", async (t) => {
  const { app, provider, server, headers, shareA2a } = await fixture(t);
  await shareA2a();
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  provider.complete = async (request) => {
    await Promise.race([held, new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))]);
    request.signal.throwIfAborted();
    return { content: "late", toolCalls: [] };
  };
  const sending = fetch(`${server.url}/a2a`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { id: "slow-1", message: { role: "user", parts: [{ type: "text", text: "take your time" }] } } }),
  }).then((r) => r.json());
  for (let i = 0; i < 200 && !app.store.runs(app.runtime.owner).length; i++) await delay(25);
  const cancelled = await fetch(`${server.url}/a2a`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: "slow-1" } }),
  }).then((r) => r.json());
  assert.equal(cancelled.result.status.state, "canceled");
  release();
  const sent = await sending;
  assert.equal(sent.result.status.state, "canceled");
});

test("one calling assistant only gets so many tasks a minute", async (t) => {
  const { app, rpc, shareA2a } = await fixture(t);
  await shareA2a();
  app.a2a.options.tasksPerMinute = 2;
  const send = (n) => rpc("tasks/send", { id: `r${n}`, message: { role: "user", parts: [{ type: "text", text: `task ${n}` }] } }, { "x-branch-agent": "Ada" });
  assert.equal((await send(1)).status, 200);
  assert.equal((await send(2)).status, 200);
  const third = await send(3);
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, -32003);
});

// ------------------------------------------------- incoming tasks are capped

test("a task from another assistant never gets more freedom than ask before changes", async (t) => {
  const { app, rpc, shareA2a } = await fixture(t);
  await shareA2a();
  // The owner has given themselves a standing yes for everything.
  app.store.save("settings", app.runtime.owner, "policy", {
    preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "allow", remember: "always" }],
    limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 },
  });
  assert.equal(app.runtime.policy("owner").rules[0].decision, "allow", "the owner keeps their standing yes");
  const capped = app.runtime.policy("a2a");
  assert.ok(!capped.rules.some((rule) => rule.decision === "allow"), "a standing yes does not travel to an outside assistant");
  assert.ok(capped.rules.some((rule) => rule.decision === "ask" && rule.applies === "changes"), "changes are asked about instead");
  // End to end: the task stops and waits rather than writing the file.
  app.runtime.models.default.provider.toolCall = { name: "files.write", args: { path: "from-outside.txt", content: "hi" } };
  const sent = await rpc("tasks/send", { id: "capped-1", message: { role: "user", parts: [{ type: "text", text: "write a file" }] } });
  assert.equal(sent.body.result.status.state, "input-required");
  assert.match(sent.body.result.status.message.parts[0].text, /Before I go ahead/);
  assert.ok(app.runtime.approvals.waiting().length, "the owner is the one asked");
});

// ---------------------------------------------------------------- A2A client

/** A stand-in for another Branch install: a card and a JSON-RPC endpoint that echoes the task. */
async function fakeAgent(t, options = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: options.name ?? "Ada", description: "A helpful stranger", version: "1.0.0",
        url: `http://127.0.0.1:${server.address().port}/a2a`,
        skills: [{ id: "branch.ask", name: "Ask Ada" }],
      }));
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const message = JSON.parse(raw || "{}");
      seen.push({ body: message, authorization: request.headers.authorization ?? null });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { id: message.params.id, sessionId: "s1", status: { state: "completed" },
          artifacts: [{ name: "answer", parts: [{ type: "text", text: `Ada says: ${message.params.message.parts[0].text}` }] }] },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, };
}

test("an assistant elsewhere can be added by its card, asked, and removed", async (t) => {
  const { app, api } = await fixture(t);
  const ada = await fakeAgent(t);
  const added = await api("/api/agents/remote", { cardUrl: ada.url, key: "shared-key" });
  assert.equal(added.status, 200);
  assert.equal(added.body.name, "Ada");
  assert.equal(added.body.key, undefined, "a key the owner was given is never handed back out");
  const listed = await api("/api/agents/remote");
  assert.equal(listed.body.agents.length, 1);
  const context = app.runtime.context({ runId: "" });
  const answer = await app.registry.execute("agents.ask", { agent: "Ada", task: "what is the time" }, context);
  assert.equal(answer.state, "completed");
  assert.equal(answer.answer, "Ada says: what is the time");
  assert.equal(ada.seen[0].authorization, "Bearer shared-key");
  assert.equal(ada.seen[0].body.method, "tasks/send");
  assert.deepEqual(Object.keys(ada.seen[0].body.params.message.parts[0]), ["type", "text"], "only the words of the task are sent");
  const removed = await api("/api/agents/remote/remove", { agent: "Ada" });
  assert.equal(removed.body.removed, true);
  assert.equal((await api("/api/agents/remote")).body.agents.length, 0);
});

test("an assistant that was never added cannot be asked", async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(
    app.registry.execute("agents.ask", { agent: "Nobody", task: "hello" }, app.runtime.context({ runId: "" })),
    /No outside assistant called "Nobody"/,
  );
});

test("private addresses are refused unless the owner allows them", async (t) => {
  const { api } = await fixture(t, { web: { allowPrivateAddresses: false } });
  const ada = await fakeAgent(t);
  const refused = await api("/api/agents/remote", { cardUrl: ada.url });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /private|local/i);
});

test("discovery only looks at the addresses the owner types in, and pairing shares a link", async (t) => {
  const { api } = await fixture(t);
  const ada = await fakeAgent(t);
  const host = ada.url.replace("http://", "");
  const found = await api(`/api/agents/discover?targets=${host},127.0.0.1:1`);
  assert.equal(found.body.found.length, 1);
  assert.equal(found.body.found[0].name, "Ada");
  assert.equal(found.body.refused.length, 1);
  const empty = await api("/api/agents/discover?targets=");
  assert.equal(empty.status, 400);
  const pairing = await api("/api/agents/pairing");
  assert.match(pairing.body.code, /^[0-9a-f]{12}$/);
  assert.match(pairing.body.cardUrl, /\/\.well-known\/agent\.json$/);
  assert.match(pairing.body.shareUrl, /^branch:\/\/add-agent\?card=/);
  const paired = await api("/api/agents/pair", { link: `branch://add-agent?card=${encodeURIComponent(`${ada.url}/.well-known/agent.json`)}&key=k&code=abc` });
  assert.equal(paired.body.name, "Ada");
});

// ---------------------------------------------------------------------- ACP

/** Drives an ACP connection over a pair of pipes, collecting everything Branch sends. */
function acpPair(t, app) {
  const toAgent = new PassThrough(), fromAgent = new PassThrough();
  const connection = new AcpConnection(app.runtime, app.store, { input: toAgent, output: fromAgent, log: () => {} });
  const messages = [];
  const waiters = [];
  let buffer = "";
  fromAgent.setEncoding("utf8");
  fromAgent.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      messages.push(JSON.parse(line));
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const serving = connection.serve();
  t.after(async () => { toAgent.end(); await serving; });
  const send = (message) => toAgent.write(`${JSON.stringify(message)}\n`);
  const until = async (match) => {
    for (let i = 0; i < 400; i++) {
      const found = messages.find(match);
      if (found) return found;
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 25); });
    }
    throw new Error(`Timed out waiting; saw ${JSON.stringify(messages)}`);
  };
  return { send, messages, until };
}

test("an editor says hello, opens a conversation and gets the answer word by word", async (t) => {
  const { app } = await fixture(t);
  const acp = acpPair(t, app);
  acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  const hello = await acp.until((m) => m.id === 1);
  assert.equal(hello.result.protocolVersion, 1);
  assert.deepEqual(hello.result.authMethods, []);
  acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ".", mcpServers: [] } });
  const opened = await acp.until((m) => m.id === 2);
  const sessionId = opened.result.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  acp.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello there" }] } });
  const done = await acp.until((m) => m.id === 3);
  assert.equal(done.result.stopReason, "end_turn");
  const chunks = acp.messages.filter((m) => m.method === "session/update");
  assert.ok(chunks.length >= 2, "the answer arrives in pieces");
  assert.equal(chunks[0].params.update.sessionUpdate, "agent_message_chunk");
  assert.match(chunks.map((c) => c.params.update.content.text).join(""), /hello there/);
});

test("a request before hello is refused, and an attachment is not read", async (t) => {
  const { app } = await fixture(t);
  const acp = acpPair(t, app);
  acp.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  const early = await acp.until((m) => m.id === 1);
  assert.match(early.error.message, /initialize first/);
  acp.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } });
  await acp.until((m) => m.id === 2);
  acp.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: {} });
  const sessionId = (await acp.until((m) => m.id === 3)).result.sessionId;
  acp.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "image", data: "x" }] } });
  const refused = await acp.until((m) => m.id === 4);
  assert.match(refused.error.message, /written instructions only/);
});

test("a step that needs a yes is put to the editor and the answer is honoured", async (t) => {
  const { app } = await fixture(t);
  app.store.save("settings", app.runtime.owner, "policy", {
    preset: "ask-before-changes",
    rules: [{ tool: "*", match: "*", applies: "changes", decision: "ask", remember: "session" }],
    limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 },
  });
  app.runtime.models.default.provider.toolCall = { name: "files.write", args: { path: "asked.txt", content: "hi" } };
  const acp = acpPair(t, app);
  acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await acp.until((m) => m.id === 1);
  acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
  const sessionId = (await acp.until((m) => m.id === 2)).result.sessionId;
  acp.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "write asked.txt" }] } });
  const question = await acp.until((m) => m.method === "session/request_permission");
  assert.equal(question.params.sessionId, sessionId);
  assert.match(question.params.toolCall.title, /Writing asked.txt/);
  assert.deepEqual(question.params.options.map((o) => o.optionId), ["allow", "reject"]);
  acp.send({ jsonrpc: "2.0", id: question.id, result: { outcome: { outcome: "selected", optionId: "reject" } } });
  const done = await acp.until((m) => m.id === 3);
  assert.equal(done.result.stopReason, "refusal");
  assert.equal(app.runtime.approvals.waiting(sessionId).length, 0, "the question was answered once");
});

test("branch acp-serve speaks the protocol on standard input and output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-acp-stdio-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const child = spawn(process.execPath, ["dist/cli.js", "acp-serve"], {
    cwd: projectRoot,
    env: { ...process.env, BRANCH_PROVIDER: "demo", BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = () => stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const until = async (count) => {
    for (let i = 0; i < 400; i++) { if (lines().length >= count) return lines(); await delay(50); }
    throw new Error(`Timed out; stdout=${stdout} stderr=${stderr}`);
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
  const [hello] = await until(1);
  assert.equal(hello.result.protocolVersion, 1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} })}\n`);
  const opened = (await until(2))[1];
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: opened.result.sessionId, prompt: [{ type: "text", text: "run the fixture" }] } })}\n`);
  const answered = (await until(3)).find((line) => line.id === 3);
  assert.equal(answered.result.stopReason, "end_turn");
  assert.match(stderr, /ready for a code editor/);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  assert.equal(await exited, 0, "it stops cleanly when the editor closes the connection");
});
