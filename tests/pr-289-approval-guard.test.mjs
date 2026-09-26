/**
 * PR #289: a chat answering "y" to an approval.
 *
 * The bug: shownInChat was recorded before the outbound guard passed, and a bare "y" used a
 * fallback that approved an unshown request when the shown one was no longer waiting.
 *
 * The fix: (1) record shownInChat only after guard+send; (2) use fallback only when nothing
 * was ever shown; (3) if shown fingerprint no longer waits, re-show the waiting one; (4) on
 * restart (empty shownInChat), first bare "y" re-shows instead of answering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pr-289-"));
  let turn = 0;
  const provider = { name: "scripted", complete: async (request) => {
    turn++;
    if (request.messages.at(-1)?.role === "tool") return { content: "Done.", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `a${turn}`, name: "files.read", arguments: JSON.stringify({ path: "README.md" }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [];
  app.channels.mergeWindowMs = 0;
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { sent.push(text); return String(sent.length); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  const message = (text, id) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  return { app, sent, message };
}

test("(a) shown question no longer waits, different one waits: y re-shows the waiting one", async (t) => {
  const { app, sent, message } = await fixture(t);
  // Set up conversation and add two approvals.
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // Create two approvals: one shown to chat, one not.
  const fp1 = "f" + "1".repeat(31), fp2 = "f" + "2".repeat(31);
  app.runtime.approvals.ask({ runId: "run-1", sessionId, tool: "files.read", target: "file1.txt",
    label: "files.read file1.txt", question: "May it read file1.txt?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp1 });
  // Simulate the question being shown to the chat by triggering askInChat.
  const msgObj = message("", "m1");
  await app.channels["askInChat"](msgObj, "May it read file1.txt?", sessionId);
  const shownCount = sent.filter((text) => /file1\.txt/.test(text)).length;
  assert.ok(shownCount > 0, "first question should be shown to chat");
  // Approve the first question (remove it from waiting).
  app.runtime.approve(sessionId, "allow", "session", fp1, "chat");
  // Add a second question that was never shown.
  app.runtime.approvals.ask({ runId: "run-2", sessionId, tool: "network.site", target: "example.com",
    label: "network.site example.com", question: "May it open example.com?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp2 });
  const beforeY = sent.length;
  // Chat sends bare "y" (trying to answer file1.txt, which is no longer waiting).
  await app.channels.handle(message("y", "m2"));
  const afterY = sent.slice(beforeY);
  // Should be told the question is no longer waiting.
  const gotRefusal = afterY.some((text) => /no longer waiting|question is no longer/.test(text));
  assert.ok(gotRefusal, "chat should be told the shown question is no longer waiting");
  // Should be shown the new waiting question.
  const shownSite = afterY.some((text) => /example\.com/.test(text));
  assert.ok(shownSite, "chat should be shown the waiting question");
  // network.site should still be waiting.
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["network.site"]);
});

test("(c) nothing recorded, one waiting: y re-shows instead of answering", async (t) => {
  const { app, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // Add an approval that was never shown to this chat.
  const fp = "f" + "0".repeat(31);
  app.runtime.approvals.ask({ runId: "run-0", sessionId, tool: "files.read", target: "secret.txt",
    label: "files.read secret.txt", question: "May it read secret.txt?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp });
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Chat sends bare "y" (nothing was ever shown).
  const sentBefore = app.sent?.length ?? 0;
  await app.channels.handle(message("y", "m1"));
  // Question should still be waiting (re-shown, not answered).
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Now send "y" again - it should answer (was shown in previous step).
  await app.channels.handle(message("y", "m2"));
  const left = app.runtime.waitingApprovals(sessionId);
  assert.deepEqual(left.length, 0, "question shown in previous step should be answered");
});

test("(d) rooms behavior: only one waiting with no fingerprint, no shown: re-show", async (t) => {
  const { app, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // Add approval with no fingerprint (rooms-style).
  app.runtime.approvals.ask({ runId: "run-room", sessionId, tool: "files.read", target: "data.txt",
    label: "files.read data.txt", question: "May it read data.txt?", source: "owner", remember: "session",
    askedAt: new Date().toISOString() });
  // With one waiting and nothing shown: should re-show.
  await app.channels.handle(message("y", "m1"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Add a second approval.
  app.runtime.approvals.ask({ runId: "run-room2", sessionId, tool: "network.site", target: "example.com",
    label: "network.site example.com", question: "May it open example.com?", source: "owner", remember: "session",
    askedAt: new Date().toISOString() });
  // With multiple waiting and no fingerprint: should refuse.
  const sentBefore = (app.sent || []).length;
  await app.channels.handle(message("y", "m2"));
  // Both should still be waiting (refused, not answered).
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool).sort(), ["files.read", "network.site"]);
});
