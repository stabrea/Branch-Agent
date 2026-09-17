import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { startServer } from "../dist/server.js";
import { createBranch, TelegramAdapter, SlackAdapter, DiscordAdapter } from "../dist/index.js";
import { chunkText, openFenceAt } from "../dist/channels/deliveries.js";
import { LiveStatus, renderProgress, statusEmoji } from "../dist/channels/live-status.js";
import { parseChatCommand, keepEnds } from "../dist/channels/chat-commands.js";

// Wave mac2 (chat-live): seeing and steering Branch from a chat app. Every chat service here is a
// stand-in; nothing leaves this computer.

const fast = { progressAfterMs: 30, editEveryMs: 10, typingEveryMs: 20, reactEveryMs: 5 };

async function until(check, label, tries = 400) {
  for (let i = 0; i < tries; i++) { const value = check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
/** A chat app stand-in. `parts` picks which optional abilities it has. */
function fakeChat(id = "chat", parts = { typing: true, react: true, edit: true }, options = {}) {
  const calls = [];
  let next = 100;
  const adapter = {
    id, kind: "fake", botName: () => "Branch",
    async start() {}, async stop() {},
    async send(chatId, text, replyTo) {
      calls.push({ op: "send", chatId, text, replyTo });
      return options.noIds ? undefined : String(next++);
    },
  };
  if (parts.typing) adapter.sendTyping = async (chatId) => { calls.push({ op: "typing", chatId }); };
  if (parts.react) adapter.react = async (chatId, messageId, emoji, previous) => { calls.push({ op: "react", chatId, messageId, emoji, previous }); };
  if (parts.edit) adapter.edit = async (chatId, messageId, text) => { calls.push({ op: "edit", chatId, messageId, text }); };
  return { adapter, calls, sent: () => calls.filter((c) => c.op === "send").map((c) => c.text) };
}
/** A model stand-in: `script` answers each request; `gate()` holds a request until it is opened. */
function scriptedModel(script) {
  const model = { name: "scripted", requests: [], gates: [] };
  model.complete = async (request) => {
    model.requests.push(request);
    return script(request, model.requests.length, model);
  };
  model.hold = (signal) => new Promise((resolve, reject) => {
    model.gates.push(resolve);
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  model.open = () => { for (const resolve of model.gates.splice(0)) resolve(); };
  return model;
}
const echo = (request) => ({ content: `Echo: ${lastUser(request)}`, toolCalls: [] });
const lastUser = (request) => String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
async function fixture(t, script = echo, parts, options) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-live-"));
  const model = scriptedModel(script);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = fast;
  app.channels.setSwitches(allOn);
  const chat = fakeChat("chat", parts, options);
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  return { app, model, chat, root };
}
const allOn = { liveStatus: "on", commands: "on", steering: "on", splitting: "on" };
let nextId = 1;
const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner",
  senderName: "Sam", text, addressed: true, messageId: `m${nextId++}`, ...extra });

// ---- 3. long replies ------------------------------------------------------------------------

test("a long reply is split at paragraphs and a code block is closed and reopened, never left open", () => {
  const prose = "First paragraph. ".repeat(20).trim();
  const code = Array.from({ length: 60 }, (_, i) => `    line_${i} = compute(${i})  # keep indentation`).join("\n");
  const text = `${prose}\n\n\`\`\`python\n${code}\n\`\`\`\n\n${prose}`;
  const chunks = chunkText(text, 600, "on");
  assert.ok(chunks.length >= 4, "the reply needed several messages");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 600, `a chunk of ${chunk.length} is over the limit`);
    const fences = chunk.split("\n").filter((line) => /^\s{0,3}```/.test(line)).length;
    assert.equal(fences % 2, 0, `every chunk shows code as code:\n${chunk}`);
    assert.equal(openFenceAt(chunk, chunk.length), null);
  }
  assert.equal(chunks[0], prose, "the first cut falls on the paragraph break");
  const reopened = chunks.filter((chunk) => chunk.startsWith("```python\n"));
  assert.ok(reopened.length >= 2, "the code block is reopened with its language");
  assert.ok(reopened.every((chunk) => chunk.split("\n")[1].startsWith("    line_")), "indentation of the next code line is kept");
  // Nothing is lost: every code line is still there, once.
  const joined = chunks.join("\n");
  for (let i = 0; i < 60; i++) assert.equal(joined.split(`line_${i} = `).length, 2, `line ${i} appears once`);
});

test("text without code splits as before, and tiny limits never loop", () => {
  const words = "word ".repeat(1000).trim();
  const chunks = chunkText(words, 700, "on");
  assert.ok(chunks.every((chunk) => chunk.length <= 700 && !chunk.startsWith(" ") && !chunk.endsWith(" ")));
  assert.equal(chunks.join(" "), words);
  const tiny = chunkText("```\n" + "x".repeat(300) + "\n```", 50, "on");
  assert.ok(tiny.every((chunk) => chunk.length <= 50));
  assert.deepEqual(chunkText("   "), ["(empty message)"]);
  // A tilde fence and a longer closing fence are understood too.
  assert.deepEqual(openFenceAt("~~~js\nlet a;\n", 12), { line: "~~~js", close: "~~~" });
  assert.equal(openFenceAt("````\ncode\n`````\nafter", 20), null);
});

test("a delivered reply keeps its code blocks whole on a channel with a short limit", async (t) => {
  const { app, chat } = await fixture(t);
  chat.adapter.maxTextLength = 300;
  const code = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join("\n");
  await app.channels.deliver("chat", "c1", `Here:\n\n\`\`\`\n${code}\n\`\`\``, "code:1");
  const sent = chat.sent();
  assert.ok(sent.length >= 2);
  for (const text of sent) assert.equal(text.split("\n").filter((l) => l.startsWith("```")).length % 2, 0);
});

// ---- 1. working status ----------------------------------------------------------------------

test("the progress message lists steps, then shows the reply as it is written", () => {
  assert.equal(renderProgress([], "", 100), "Working on it…");
  const steps = [{ label: "Looking through notes", state: "done" }, { label: "Reading plan.md", state: "working" }];
  assert.equal(renderProgress(steps, "", 200), "Working on it (1 of 2 steps done)…\n✓ Looking through notes\n… Reading plan.md");
  assert.equal(renderProgress(steps, "Half an answ", 200), "(2 steps)\n\nHalf an answ");
  assert.ok(renderProgress(steps, "y".repeat(500), 120).endsWith(" …"));
  assert.ok(renderProgress(steps, "y".repeat(500), 120).length <= 120);
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `step ${i}`, state: "done" }));
  assert.match(renderProgress(many, "", 500), /\(4 earlier\)\n✓ step 4/);
});

test("live status: seen, typing, tool steps, streamed text, and the reply put into the progress message", async (t) => {
  const chat = fakeChat();
  const guarded = [];
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c1", messageId: "q1" },
    async (text) => { guarded.push(text); return { text, blocked: false }; }, fast);
  live.start();
  await until(() => chat.calls.some((c) => c.op === "react"), "seen");
  assert.deepEqual(chat.calls.find((c) => c.op === "react"), { op: "react", chatId: "c1", messageId: "q1", emoji: statusEmoji.queued, previous: undefined });
  live.thinking();
  live.event("tool.started", { name: "tools.search", id: "x" });
  live.event("tool.started", { name: "files.read", id: "a", label: "Reading\nplan.md" });
  await until(() => chat.calls.some((c) => c.op === "react" && c.emoji === statusEmoji.tool), "tool reaction");
  const opened = await until(() => chat.calls.find((c) => c.op === "send"), "progress message");
  assert.equal(opened.replyTo, "q1");
  assert.match(opened.text, /… Reading plan\.md/);
  assert.doesNotMatch(opened.text, /tools\.search/, "finding a tool is not a step of the work");
  live.event("tool.completed", { name: "files.read", id: "a" });
  await until(() => chat.calls.some((c) => c.op === "edit" && /✓ Reading plan\.md/.test(c.text)), "step marked done");
  live.event("model.started", {});
  live.text("The plan ");
  live.text("says yes.");
  await until(() => chat.calls.some((c) => c.op === "edit" && c.text.endsWith("The plan says yes.")), "streamed reply");
  await until(() => chat.calls.filter((c) => c.op === "react").at(-1)?.emoji === statusEmoji.thinking, "thinking again");
  const placed = await live.finish("done", "The plan says yes.");
  assert.deepEqual(placed, { messageId: "100", text: "The plan says yes." });
  const reactions = chat.calls.filter((c) => c.op === "react");
  assert.deepEqual(reactions.at(-1), { op: "react", chatId: "c1", messageId: "q1", emoji: statusEmoji.done, previous: statusEmoji.thinking });
  assert.ok(chat.calls.filter((c) => c.op === "typing").length >= 1);
  assert.ok(guarded.includes("The plan says yes."), "the reply passed the last look before it went out");
  const count = chat.calls.length;
  await delay(80);
  assert.equal(chat.calls.length, count, "nothing more happens once the task is over");
});

test("live status: held-back text is not streamed, a failing part is left alone, and no id means no edits", async (t) => {
  const chat = fakeChat();
  let failures = 0;
  chat.adapter.react = async () => { failures++; throw new Error("reactions refused"); };
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c1", messageId: "q1" },
    async (text) => ({ text, blocked: /secret/.test(text) }), fast);
  live.start();
  live.thinking();
  live.event("tool.started", { name: "files.read", id: "a", label: "Reading" });
  live.event("tool.started", { name: "files.read", id: "b", label: "Reading more" });
  live.event("tool.started", { name: "files.read", id: "c", label: "Reading again" });
  await until(() => chat.calls.some((c) => c.op === "send"), "progress message");
  live.text("the secret is 42");
  await delay(60);
  assert.ok(chat.calls.every((c) => !/secret/.test(c.text ?? "")), "held-back words never reach the chat");
  assert.equal(await live.finish("done", "the secret is 42"), null, "a held-back reply is not put in the message");
  assert.equal(chat.calls.filter((c) => c.op === "edit").at(-1).text, "Done (3 steps).");
  assert.equal(failures, 2, "reactions were given up after two refusals");

  const quiet = fakeChat("quiet", { typing: false, react: false, edit: true }, { noIds: true });
  const blind = new LiveStatus({ adapter: quiet.adapter, chatId: "c1", messageId: "q1" }, async (text) => ({ text, blocked: false }), fast);
  blind.start();
  blind.thinking();
  await until(() => quiet.calls.some((c) => c.op === "send"), "progress message without an id");
  blind.text("streaming");
  assert.equal(await blind.finish("done", "streaming"), null, "without an id the reply goes the ordinary way");
  assert.equal(quiet.calls.filter((c) => c.op === "edit").length, 0);
});

test("a chat that has none of the extras still gets exactly one reply", async (t) => {
  const { app, chat } = await fixture(t, echo, { typing: false, react: false, edit: false });
  assert.equal(await app.channels.handle(message("hello")), "replied");
  assert.deepEqual(chat.calls.map((c) => c.op), ["send"]);
  assert.equal(chat.sent()[0], "Echo: hello");
});

test("a slow task shows its steps and its reply lands in the progress message, written down once", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] };
    await self.hold(request.signal);
    return { content: "All tidy.", toolCalls: [] };
  });
  const outcome = app.channels.handle(message("tidy up"));
  const progress = await until(() => chat.calls.find((c) => c.op === "send"), "progress message");
  assert.match(progress.text, /Looking through/);
  model.open();
  assert.equal(await outcome, "replied");
  assert.equal(chat.sent().length, 1, "the reply did not arrive twice");
  assert.equal(chat.calls.filter((c) => c.op === "edit").at(-1).text, "All tidy.");
  const [row] = app.channels.deliveries.list().filter((d) => d.key.startsWith("reply:"));
  assert.equal(row.status, "sent");
  assert.equal(row.messageId, "100");
  assert.equal(row.text, "All tidy.");
  assert.ok(chat.calls.some((c) => c.op === "typing"));
  assert.equal(chat.calls.filter((c) => c.op === "react").at(-1).emoji, statusEmoji.done);
});

test("under Lockdown or quiet hours nothing but the reply is attempted", async (t) => {
  const { app, chat } = await fixture(t);
  app.channels.liveAllowed = () => false;
  await app.channels.handle(message("one"));
  assert.deepEqual(chat.calls.map((c) => c.op), ["send"]);
  app.channels.liveAllowed = () => true;
  app.channels.deliveries.holdUntil = () => new Date(Date.now() + 3600000).toISOString();
  await app.channels.handle(message("two"));
  assert.deepEqual(chat.calls.map((c) => c.op), ["send"], "quiet hours hold the reply and show nothing");
});

// ---- 2. control from the chat ---------------------------------------------------------------

test("commands are read only when they are commands", () => {
  assert.deepEqual(parseChatCommand("/stop"), { name: "stop", argument: "" });
  assert.deepEqual(parseChatCommand("  /BTW  what is 2+2 "), { name: "btw", argument: "what is 2+2" });
  assert.deepEqual(parseChatCommand("/usage@BranchBot on"), { name: "usage", argument: "on" });
  assert.equal(parseChatCommand("/deploy now"), null);
  assert.equal(parseChatCommand("please /stop"), null);
  assert.equal(keepEnds("abcdefghij".repeat(10), 60).length <= 60, true);
});

test("messages sent in quick succession become one turn with one answer", async (t) => {
  const { app, chat, model } = await fixture(t);
  app.channels.mergeWindowMs = 80;
  const first = app.channels.handle(message("book a table"));
  await delay(10);
  const second = app.channels.handle(message("for four people"));
  assert.deepEqual(await Promise.all([first, second]), ["replied", "replied"]);
  assert.equal(model.requests.length, 1);
  assert.equal(lastUser(model.requests[0]), "book a table\nfor four people");
  assert.deepEqual(chat.sent(), ["Echo: book a table\nfor four people"]);
});

test("a message sent while a task works steers it instead of starting another", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    if (n === 1) {
      await self.hold(request.signal);
      return { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] };
    }
    return { content: `Final after: ${request.messages.map((m) => m.content).join(" | ")}`, toolCalls: [] };
  });
  const outcome = app.channels.handle(message("summarise the folder"));
  await until(() => model.requests.length === 1, "task started");
  const note = message("only the markdown files");
  assert.equal(await app.channels.handle(note), "replied");
  model.open();
  assert.equal(await outcome, "replied");
  assert.equal(model.requests.length, 2, "no second task was started");
  assert.match(lastUser(model.requests[1]), /Note from the person.*only the markdown files/);
  assert.ok(chat.calls.some((c) => c.op === "react" && c.emoji === statusEmoji.queued && c.messageId === note.messageId), "the note was marked seen");
  assert.equal(chat.sent().filter((text) => text.startsWith("Final after")).length, 1);
});

test("a note the task could not read in time becomes the next turn, not a lost message", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    if (n === 1) { await self.hold(request.signal); return { content: "First answer.", toolCalls: [] }; }
    return echo(request);
  });
  const outcome = app.channels.handle(message("draft a note"));
  await until(() => model.requests.length === 1, "task started");
  await app.channels.handle(message("and sign it Sam"));
  model.open();
  assert.equal(await outcome, "replied");
  await until(() => chat.sent().includes("Echo: and sign it Sam"), "the late note is answered as its own turn");
  assert.equal(model.requests.length, 2);
  assert.ok(chat.sent().includes("First answer."));
});

test("/stop ends the running task, and /status says what is going on", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    await self.hold(request.signal);
    return { content: "never", toolCalls: [] };
  });
  assert.equal(await app.channels.handle(message("/status")), "replied");
  assert.equal(chat.sent().at(-1), "Nothing is working right now.");
  const outcome = app.channels.handle(message("count the stars"));
  await until(() => model.requests.length === 1, "task started");
  await app.channels.handle(message("/status"));
  assert.match(chat.sent().at(-1), /^Working for \d+ s, 0 steps so far \(0 done\)\.\nThinking about it\.$/);
  await app.channels.handle(message("/stop"));
  assert.match(chat.sent().at(-1), /^Stopping\./);
  assert.equal(await outcome, "failed");
  assert.equal(chat.sent().at(-1), "Stopped.");
  assert.equal(chat.calls.filter((c) => c.op === "react").at(-1).emoji, statusEmoji.error);
  assert.equal(model.requests.length, 1, "the words /stop and /status never reached the model");
});

test("/stop during the gathering moment drops the message before anything starts", async (t) => {
  const { app, chat, model } = await fixture(t);
  app.channels.mergeWindowMs = 100;
  const outcome = app.channels.handle(message("send the report"));
  await delay(10);
  await app.channels.handle(message("/stop"));
  assert.equal(await outcome, "ignored");
  assert.equal(model.requests.length, 0);
  assert.deepEqual(chat.sent(), ["Dropped that. Nothing was started."]);
  assert.ok(chat.calls.every((c) => c.op !== "edit"), "no progress message for a task that never started");
  assert.deepEqual(chat.calls.filter((c) => c.op === "react").map((c) => c.emoji), [statusEmoji.queued]);
});

test("only a few chats have a task working at once; the others wait their turn", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    await self.hold(request.signal);
    return echo(request);
  });
  app.channels.maxChatTasks = 2;
  const outcomes = ["a", "b", "c"].map((chatId) => app.channels.handle(message(`hi from ${chatId}`, { chatId })));
  await until(() => model.requests.length === 2, "two tasks started");
  await delay(50);
  assert.equal(model.requests.length, 2, "the third chat waits");
  model.open();
  await until(() => model.requests.length === 3 && model.gates.length === 1, "the third task started once a slot was free");
  model.open();
  assert.deepEqual(await Promise.all(outcomes), ["replied", "replied", "replied"]);
  const replies = app.channels.deliveries.list().filter((d) => d.key.startsWith("reply:"));
  assert.deepEqual(replies.map((d) => d.chatId).sort(), ["a", "b", "c"]);
  assert.ok(replies.every((d) => d.status === "sent"));
  void chat;
});

test("/new starts a fresh conversation and /usage adds a tokens-and-cost line", async (t) => {
  const { app, chat } = await fixture(t);
  await app.channels.handle(message("remember the blue door"));
  const before = app.channels.chats(app.runtime.owner).find((c) => c.chatId === "c1").sessionId;
  await app.channels.handle(message("/usage on"));
  assert.match(chat.sent().at(-1), /end with a tokens-and-cost line/);
  await app.channels.handle(message("again"));
  assert.match(chat.sent().at(-1), /^Echo: again\n\n\[tokens: about \d+ in, about \d+ out \(an estimate\)/);
  await app.channels.handle(message("/new"));
  assert.match(chat.sent().at(-1), /next message starts a new conversation/);
  assert.ok(app.channels.chats(app.runtime.owner).some((c) => c.chatId === "c1"), "the chat is still listed");
  await app.channels.handle(message("hello again"));
  const after = app.channels.chats(app.runtime.owner).find((c) => c.chatId === "c1").sessionId;
  assert.ok(before && after && before !== after, "a new conversation was started");
  assert.ok(app.store.messages(before).length >= 2, "the old conversation is kept");
  await app.channels.handle(message("/usage off"));
  await app.channels.handle(message("plain"));
  assert.equal(chat.sent().at(-1), "Echo: plain");
});

test("/btw is answered on the side with no tools and never joins the task", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    if (lastUser(request).includes("side question")) return { content: `It is ${request.tools?.length ?? 0} tools.`, toolCalls: [] };
    await self.hold(request.signal);
    return { content: "Main answer.", toolCalls: [] };
  });
  const outcome = app.channels.handle(message("plan the trip"));
  await until(() => model.requests.length === 1, "task started");
  await app.channels.handle(message("/btw how many tools do you have?"));
  assert.equal(chat.sent().at(-1), "(on the side) It is 0 tools.");
  model.open();
  await outcome;
  const sessionId = app.channels.chats(app.runtime.owner).find((c) => c.chatId === "c1").sessionId;
  assert.ok(app.store.messages(sessionId).every((m) => !String(m.content).includes("how many tools")), "the side question is not in the conversation");
  assert.ok(!lastUser(model.requests[0]).includes("how many tools"));
});

test("/compact folds the earlier part of the conversation into a summary", async (t) => {
  const { app, chat } = await fixture(t, (request) => lastUser(request).startsWith("Summarize the conversation")
    ? { content: JSON.stringify({ goals: ["plan a garden"], decisions: ["tomatoes"], openQuestions: [], filesTouched: [] }), toolCalls: [] }
    : echo(request));
  await app.channels.handle(message("/compact"));
  assert.equal(chat.sent().at(-1), "There is nothing to fold yet.");
  for (let i = 0; i < 6; i++) await app.channels.handle(message(`garden note ${i}`));
  await app.channels.handle(message("/compact"));
  assert.match(chat.sent().at(-1), /^Folded \d+ earlier messages into a summary/);
  const sessionId = app.channels.chats(app.runtime.owner).find((c) => c.chatId === "c1").sessionId;
  const working = app.store.workingMessages(sessionId);
  assert.match(working.summary, /plan a garden/);
  assert.equal(working.rows.length, 6, "the most recent messages stay as they are");
  assert.ok(app.store.messages(sessionId).length >= 12, "the stored history is untouched");
});

test("a stranger's command is answered like any stranger's message", async (t) => {
  const { app, chat, model } = await fixture(t);
  assert.equal(await app.channels.handle(message("/stop", { senderId: "stranger" })), "pairing");
  assert.match(chat.sent().at(-1), /I don't know you yet/);
  assert.equal(await app.channels.handle(message("/status", { senderId: "stranger" })), "pairing");
  assert.equal(model.requests.length, 0);
  // An unknown command is an ordinary message for an allowed sender.
  await app.channels.handle(message("/deploy the site"));
  assert.equal(chat.sent().at(-1), "Echo: /deploy the site");
});

// ---- the real adapters' new calls, against stand-in services ----------------------------------

function recordingFetch(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, body = {} } = answer(call) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("Telegram: typing, a reaction and an edit use the Bot API calls, and an unchanged edit is fine", async () => {
  const { calls, fetch } = recordingFetch((call) => call.url.endsWith("/editMessageText") && call.body.text === "same"
    ? { status: 400, body: { ok: false, description: "Bad Request: message is not modified" } }
    : { body: { ok: true, result: true } });
  const adapter = new TelegramAdapter({ id: "tg", token: "123:abc", apiBase: "http://telegram.invalid", fetch });
  await adapter.sendTyping("501");
  await adapter.react("501", "77", statusEmoji.tool, statusEmoji.queued);
  await adapter.edit("501", "78", "new words");
  await adapter.edit("501", "78", "same");
  assert.deepEqual(calls.map((c) => [c.url, c.body]), [
    ["http://telegram.invalid/bot123:abc/sendChatAction", { chat_id: 501, action: "typing" }],
    ["http://telegram.invalid/bot123:abc/setMessageReaction", { chat_id: 501, message_id: 77, reaction: [{ type: "emoji", emoji: statusEmoji.tool }] }],
    ["http://telegram.invalid/bot123:abc/editMessageText", { chat_id: 501, message_id: 78, text: "new words" }],
    ["http://telegram.invalid/bot123:abc/editMessageText", { chat_id: 501, message_id: 78, text: "same" }],
  ]);
});

test("Slack: reactions are swapped by name, edits use chat.update, and a thread reply reacts on the message itself", async () => {
  const { calls, fetch } = recordingFetch(() => ({ body: { ok: true } }));
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", apiBase: "http://slack.invalid", fetch });
  await adapter.react("C1", "171.1", statusEmoji.done, statusEmoji.tool);
  await adapter.edit("C1", "171.2", "**bold** move");
  assert.deepEqual(calls.map((c) => [c.url.split("/").pop(), c.body]), [
    ["reactions.remove", { channel: "C1", timestamp: "171.1", name: "technologist" }],
    ["reactions.add", { channel: "C1", timestamp: "171.1", name: "+1" }],
    ["chat.update", { channel: "C1", ts: "171.2", text: "*bold* move" }],
  ]);
  assert.equal(calls[0].headers.authorization, "Bearer xoxb-1");
  assert.equal(adapter.sendTyping, undefined, "Slack apps have no typing indicator");
  await assert.rejects(adapter.react("C1", "171.1", "🦄"), /no name for that reaction/);
});

test("Discord: an edit is a PATCH of the message, cut to Discord's limit", async () => {
  const { calls, fetch } = recordingFetch(() => ({ body: {} }));
  const adapter = new DiscordAdapter({ id: "discord", token: "tok", apiBase: "http://discord.invalid", fetch });
  await adapter.edit("c1", "m9", "z".repeat(2500));
  await adapter.react("c1", "m9", statusEmoji.done, statusEmoji.done);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, "http://discord.invalid/channels/c1/messages/m9");
  assert.equal(calls[0].body.content.length, 2000);
  assert.equal(calls[0].headers.authorization, "Bot tok");
  assert.deepEqual(calls.slice(1).map((c) => [c.method, c.url]), [
    ["PUT", `http://discord.invalid/channels/c1/messages/m9/reactions/${encodeURIComponent(statusEmoji.done)}/@me`],
  ], "the same reaction is not taken off first");
});

test("Telegram end to end: a note sent while a task works reaches it, and the chat shows the work", async (t) => {
  const { app, model } = await fixture(t, async (request, n, self) => {
    if (n === 1) {
      await self.hold(request.signal);
      return { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] };
    }
    return { content: `Done: ${lastUser(request)}`, toolCalls: [] };
  });
  const state = { queue: [], calls: [] };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const method = req.url.split("/").pop(), body = raw ? JSON.parse(raw) : {};
    state.calls.push({ method, body });
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Branch", username: "BranchTestBot" });
    if (method === "getUpdates") {
      const pending = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending.length) await delay(20);
      return reply(pending);
    }
    if (method === "sendMessage") return reply({ message_id: 5000 + state.calls.length });
    return reply(true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = new TelegramAdapter({ id: "tg", token: "1:x", apiBase: `http://127.0.0.1:${server.address().port}`, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(() => app.channels.detachAll());
  const from = { id: 42, first_name: "Ann" }, chat = { id: 501, type: "private" };
  state.queue.push({ update_id: 1, message: { message_id: 10, text: "tidy the folder", from, chat } });
  await until(() => model.requests.length === 1, "task started");
  state.queue.push({ update_id: 2, message: { message_id: 11, text: "skip the photos", from, chat } });
  await until(() => state.calls.some((c) => c.method === "setMessageReaction" && c.body.message_id === 11), "the note was marked seen");
  model.open();
  // The answer arrives as a message, or as the progress message edited into it.
  await until(() => state.calls.some((c) => ["sendMessage", "editMessageText"].includes(c.method) && /^Done: .*skip the photos/s.test(c.body.text)),
    "answer that read the note");
  assert.equal(model.requests.length, 2, "the note did not start a second task");
  assert.ok(state.calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing"));
  assert.ok(state.calls.some((c) => c.method === "setMessageReaction" && c.body.message_id === 10));
});

// ---- the owner's switches: on / off / when needed, all off on a fresh install ------------------

test("a fresh install has every chat extra switched off and answers exactly as before", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-live-"));
  const model = scriptedModel(async (request, n, self) => {
    if (n === 1) await self.hold(request.signal);
    return echo(request);
  });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.liveTiming = fast;
  assert.deepEqual(app.channels.summary().live, { liveStatus: "off", commands: "off", steering: "off", splitting: "off" });
  const chat = fakeChat();
  await app.channels.attach(chat.adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const first = app.channels.handle(message("write the plan"));
  await until(() => model.requests.length === 1, "task started");
  // Off: "/status" is an ordinary message, and a message for a busy chat waits its turn.
  const second = app.channels.handle(message("/status"));
  await delay(80);
  assert.equal(model.requests.length, 1, "the second message waits for the first task");
  model.open();
  assert.deepEqual(await Promise.all([first, second]), ["replied", "replied"]);
  assert.deepEqual(chat.sent(), ["Echo: write the plan", "Echo: /status"]);
  assert.deepEqual(chat.calls.map((c) => c.op), ["send", "send"], "no typing, reactions or progress");
  // Off: long text splits the old way, even with code in it.
  const code = "```\n" + "a = 1\n".repeat(200) + "```";
  assert.deepEqual(chunkText(code, 300), chunkText(code, 300, "off"));
  assert.ok(chunkText(code, 300).some((chunk) => chunk.split("\n").filter((l) => l.startsWith("```")).length % 2 === 1));
});

test("switches are saved one at a time and refuse anything but on, off and when needed", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(app.channels.setSwitches({ commands: "when-needed" }),
    { liveStatus: "on", commands: "when-needed", steering: "on", splitting: "on" });
  assert.throws(() => app.channels.setSwitches({ commands: "sometimes" }));
  assert.throws(() => app.channels.setSwitches({ typing: "on" }));
  assert.equal(app.channels.switches().commands, "when-needed");
});

test("when needed: commands only while a task works, steering without the wait, status only for a slow task", async (t) => {
  const { app, chat, model } = await fixture(t, async (request, n, self) => {
    if (lastUser(request) === "slow") await self.hold(request.signal);
    return echo(request);
  });
  app.channels.mergeWindowMs = 5000; // only "on" waits to gather; this must not be waited for
  app.channels.setSwitches({ liveStatus: "when-needed", commands: "when-needed", steering: "when-needed" });
  const steered = [];
  app.store.onEvent((runId, kind, data) => { if (kind === "run.steered") steered.push(data.note); });
  // Idle: a command is an ordinary message, and a quick answer shows nothing but the answer.
  assert.equal(await app.channels.handle(message("/status")), "replied");
  assert.deepEqual(chat.calls.map((c) => c.op), ["send"]);
  assert.equal(chat.sent()[0], "Echo: /status");
  // Busy: /status is read, /new is not, and after a while the chat shows the work.
  const slow = app.channels.handle(message("slow"));
  await until(() => model.requests.length === 2, "slow task started");
  await until(() => chat.calls.some((c) => c.op === "typing"), "typing once the task is slow");
  await until(() => chat.calls.some((c) => c.op === "react" && c.emoji === statusEmoji.thinking), "the reaction once the task is slow");
  await app.channels.handle(message("/status"));
  assert.match(chat.sent().at(-1), /^Working for/);
  await app.channels.handle(message("/new"));
  assert.equal(model.requests.length, 2, "while busy, /new is a note to the task, not a new task");
  model.open();
  assert.equal(await slow, "replied");
  assert.ok(steered.some((note) => note === "/new"), "the message was steered into the running task");
});

test("when needed: careful splitting only for a reply with code in it", () => {
  const prose = ("word ".repeat(30) + "\n\n").repeat(20);
  assert.deepEqual(chunkText(prose, 400, "when-needed"), chunkText(prose, 400, "off"));
  const code = "Look:\n```js\n" + "let a = 1;\n".repeat(100) + "```";
  assert.deepEqual(chunkText(code, 400, "when-needed"), chunkText(code, 400, "on"));
  assert.notDeepEqual(chunkText(code, 400, "when-needed"), chunkText(code, 400, "off"));
});

test("the switches are read and changed over the app's own address, and bad values are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-live-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scriptedModel(echo) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(server.url + "/api/" + path, {
    method: body ? "POST" : "GET", body: body && JSON.stringify(body),
    headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body ? { "content-type": "application/json" } : {}) },
  });
  assert.deepEqual((await (await call("channels")).json()).live, { liveStatus: "off", commands: "off", steering: "off", splitting: "off" });
  const saved = await (await call("channels/live", { steering: "when-needed" })).json();
  assert.equal(saved.live.steering, "when-needed");
  assert.equal(saved.live.commands, "off");
  assert.equal((await call("channels/live", { steering: "always" })).ok, false);
  assert.equal((await (await call("channels")).json()).live.steering, "when-needed");
});

/** The one place these tests look for the card; it moves to tests/places.mjs when the redesign lands. */
async function chatLiveCard() {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf('<form id="chat-live-form"');
  return html.slice(start, html.indexOf("</form>", start));
}

test("the chat-app card lives under Customize, Chat apps, and every word has English and real French", async () => {
  const card = await chatLiveCard();
  assert.match(card, /data-home="customize:channels"/);
  assert.equal((card.match(/<h2 /g) ?? []).length, 1);
  assert.equal((card.match(/<button /g) ?? []).length, 1, "one filled button");
  assert.doesNotMatch(card, /style=|#[0-9a-f]{3,8}\b|rgba?\(/i, "no colours written in the card");
  const keys = [...card.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1]);
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const key of [...keys, "settings.chat-live.saved", "settings.chat-live.failed"]) {
    assert.ok(english[key], `${key} has English words`);
    assert.ok(french[key] && french[key] !== english[key], `${key} has its own French`);
  }
  for (const name of ["liveStatus", "commands", "steering", "splitting"]) assert.match(card, new RegExp(`name="${name}"`));
  const script = await readFile(new URL("../public/chat-live.js", import.meta.url), "utf8");
  assert.match(script, /api\("channels\/live", change\)/);
});
