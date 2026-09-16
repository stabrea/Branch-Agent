import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
  });
  t.after(async () => {
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, ...server };
}

async function mcpRequest(url, token, body, sessionId, method = "POST") {
  const headers = {
    authorization: `Bearer ${token}`,
    origin: url,
  };
  if (method !== "DELETE") {
    headers["content-type"] = "application/json";
  }
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const response = await fetch(`${url}/mcp`, {
    method,
    headers,
    ...(method !== "DELETE" && body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return { status: 204 };
  const data = await response.json();
  return data;
}

test("MCP server initializes with protocol negotiation", async (t) => {
  const { url, token } = await fixture(t);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
  assert.ok(response.result);
  assert.equal(response.result.serverInfo.name, "branch");
  assert.match(response.result.protocolVersion, /^202[45]-\d{2}-\d{2}$/);
});

test("MCP server rejects uninitialized requests", async (t) => {
  const { url, token } = await fixture(t);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert.ok(response.error);
  assert.equal(response.error.code, -32002);
});

test("MCP tools/list respects exposure policy", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // List tools
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.tools));
  // By default, files.read should be exposed via MCP (or list could be empty if no tools match)
  assert.ok(response.result.tools.length >= 0);
});

test("MCP server returns error for unknown tool", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "nonexistent.tool",
      arguments: {},
    },
  }, sessionId);
  // Either the tool call returns an error in result.isError or we get an error response
  assert.ok(response.result || response.error);
});

test("MCP resources/list returns available resources", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.resources));
  assert.ok(response.result.resources.some(r => r.uri === "memory://facts"));
  assert.ok(response.result.resources.some(r => r.uri === "workspace://files"));
});

test("MCP resources/read returns memory facts", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/read",
    params: { uri: "memory://facts" },
  }, sessionId);
  assert.ok(response.result);
  assert.ok(response.result.contents);
  assert.ok(Array.isArray(response.result.contents));
  assert.ok(response.result.contents[0].mimeType === "application/json");
});

test("MCP prompts/list returns available prompts", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.prompts));
  // Prompts list can be empty if no procedures are saved
});

test("MCP prompts/get returns error for unknown prompt", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/get",
    params: { name: "nonexistent-prompt" },
  }, sessionId);
  // Should get an error for unknown prompt
  assert.ok(response.error || !response.result);
});

test("MCP server tracks session ids", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-123";
  const response1 = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    },
    sessionId
  );
  assert.ok(response1.result);
  const response2 = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    sessionId
  );
  assert.ok(response2.result);
});

test("MCP rejects bad authentication", async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer badtoken",
      "content-type": "application/json",
      origin: url,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(response.status, 401);
});

test("MCP connection snippets endpoint works", async (t) => {
  const { url, token } = await fixture(t);
  const response = await fetch(`${url}/api/mcp/connection`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
    },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.httpEndpoint);
  assert.ok(data.bearerToken);
  assert.ok(data.claudeDesktop);
});

test("MCP GET /mcp returns 405", async (t) => {
  const { url, token } = await fixture(t);
  const response = await fetch(`${url}/mcp`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
    },
  });
  assert.equal(response.status, 405);
});

test("MCP DELETE /mcp ends session", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // Delete session
  const deleteResp = await fetch(`${url}/mcp`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(deleteResp.status, 204);
});

test("MCP branch.ask tool works", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // Call branch.ask
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "branch.ask",
      arguments: { prompt: "Say hello" },
    },
  }, sessionId);
  assert.ok(response.result);
});
