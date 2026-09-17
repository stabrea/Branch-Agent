/**
 * mac6/bucket-23, rows that were already true, with the assertion that proves each one.
 *
 * A0464 (persistent desktop chat sessions): the desktop app keeps its data folder under the app's
 * own user-data folder (src/desktop/main.ts) and the engine it opens there keeps every conversation
 * in its database, so a conversation is listed, and continues with what was said, after the app is
 * closed and opened again. The restart is done here on the engine the desktop runs, never through
 * Electron.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function remembering() {
  return { name: "scripted", async complete(request) {
    const said = request.messages.filter((m) => m.role === "user").map((m) => m.content);
    return { content: `You have said: ${said.join(" / ")}`, toolCalls: [] };
  } };
}

async function open(data, workspace) {
  const app = await createBranch({ workspace, dataDir: data, provider: remembering() });
  const server = await startServer(app, { dataDir: data, port: 0 });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { app, api, close: async () => { await server.close(); await app.close(); } };
}

test("A0464 a desktop conversation is still listed after the app is closed, and carries on from where it was", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-desktop-sessions-"));
  let second;
  // One hook, the app closed before its folder goes: Windows will not delete an open database.
  t.after(async () => { await second?.close(); await discardTemp(root); });
  const data = join(root, "data"), workspace = join(root, "workspace");
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /app\.getPath\("userData"\)/, "the desktop keeps its data under the app's own folder");

  const first = await open(data, workspace);
  const run = await first.api("/api/run", { prompt: "remember the oak" });
  await first.close();

  second = await open(data, workspace);
  const listed = await second.api("/api/sessions");
  const sessions = Array.isArray(listed) ? listed : listed.sessions;
  assert.ok(sessions.some((session) => session.sessionId === run.sessionId), "the conversation is listed after the restart");
  const next = await second.api("/api/run", { prompt: "and the acorn", sessionId: run.sessionId });
  assert.equal(next.output, "You have said: remember the oak / and the acorn", "the earlier message came back with it");
});
