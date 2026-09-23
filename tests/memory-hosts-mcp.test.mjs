/**
 * memory.cross-agent: the round trip across two genuinely different surfaces — ingest a Claude Code
 * session log in-process, then read it back through an MCP connection, which is a different program
 * (a different "host", in the MCP sense) reaching Branch over HTTP with its own session and identity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-memhosts-mcp-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, ...server };
}

async function mcpRequest(url, token, body, sessionId) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: url, "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body),
  });
  return response.json();
}

function claudeCodeLog(said) {
  const line = (uuid, parent, role, content) => JSON.stringify({ type: role, uuid, parentUuid: parent, message: { role, content } });
  return [line("u1", null, "user", said), line("a1", "u1", "assistant", "Noted.")].join("\n");
}

test("a fact ingested from a Claude Code session log is read back through a real MCP connection, a second host adapter", async (t) => {
  const { app, url, token } = await fixture(t);
  const context = app.runtime.context();
  const log = claudeCodeLog("Please review the diff. I always want changelog entries written in the imperative mood.");
  const ingested = await app.registry.execute("memory.ingest_host_log", { host: "claude-code", sessionId: "s-mcp-1", text: log }, context);
  assert.equal(ingested.imported, 1);

  const sessionId = "mcp-round-trip-" + Math.random();
  const init = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "1.0.0" } },
  }, sessionId);
  assert.ok(init.result, "a second, independent host connected over MCP");

  const read = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "memory://facts" },
  }, sessionId);
  assert.ok(read.result, JSON.stringify(read));
  const facts = JSON.parse(read.result.contents[0].text);
  const found = facts.find((f) => /changelog entries/.test(f.data.text));
  assert.ok(found, "the MCP-connected host reads back the fact the Claude Code log put into memory");
  assert.match(found.data.source, /Claude Code session log \(session s-mcp-1\)/);
  assert.equal(found.data.scope, "shared");
});
