/**
 * mac6/bucket-23, rows that were already true, with the assertion that proves each one.
 *
 * A0464 (persistent desktop chat sessions): the desktop app keeps its data folder under the app's
 * own user-data folder (src/desktop/main.ts) and the engine it opens there keeps every conversation
 * in its database, so a conversation is listed, and continues with what was said, after the app is
 * closed and opened again. The restart is done here on the engine the desktop runs, never through
 * Electron.
 *
 * A2043 (computer use on a Mac): the shared computer.look / computer.press / computer.type tools reach
 * a window through the screen layer, and on a Mac that layer is one fixed JXA script run by osascript.
 * The osascript here is a stand-in that records what it was asked; the Stop notice is a stand-in too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Budget, createBranch, ToolRegistry } from "../dist/index.js";
import { Store } from "../dist/store.js";
import { registerComputer } from "../dist/integrations/computer.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { DesktopScriptRunner } from "../dist/integrations/desktop-script.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";
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

test("A2043 computer.look, computer.press and computer.type reach a Mac window through the one osascript script", async (t) => {
  const calls = [];
  const exec = async (executable, args) => {
    calls.push({ executable, verb: args[3] });
    const result = args[3] === "windows"
      ? { windows: [{ handle: "501:1", title: "Notes", program: "Notes", processId: 501, minimised: false, width: 800, height: 600 }] }
      : args[3] === "read" ? { nodes: [{ role: "AXButton", name: "Save" }], more: false } : { clicked: "Save", how: "keys", into: "", value: "" };
    return { status: "completed", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const store = new Store(":memory:");
  const runner = new DesktopScriptRunner(undefined, { enabled: true, platform: "darwin", exec });
  const banner = { visible: true, show: async () => undefined, hide: async () => undefined };
  t.after(async () => { await runner.close(); store.close(); });
  const desktop = new DesktopControl(store, { runner, banner });
  const registry = new ToolRegistry();
  registerComputer(registry, { window: desktop });
  const run = store.createRun("local", "look at Notes");
  const context = { owner: "local", workspace: ".", runId: run.id, signal: new AbortController().signal, budget: new Budget(),
    permissions: new Set(["browser.read", "browser.interact", "desktop.view", "desktop.control"]), depth: 0 };

  await assert.rejects(registry.execute("computer.look", { at: "window", window: "Notes" }, context), /turn|switch|off/i,
    "nothing reaches the screen while the owner's switch is off");
  assert.equal(calls.length, 0);
  saveDesktopSettings(store, "local", { enabled: true });
  const looked = await registry.execute("computer.look", { at: "window", window: "Notes" }, context);
  assert.equal(looked.at, "window");
  assert.equal(looked.parts[0].name, "Save");
  await registry.execute("computer.press", { at: "window", window: "Notes", name: "Save" }, context);
  await registry.execute("computer.type", { at: "window", window: "Notes", name: "Body", text: "hello" }, context);
  assert.ok(calls.length >= 6 && calls.every((call) => call.executable === "/usr/bin/osascript"), "every step went through osascript");
  assert.deepEqual([...new Set(calls.map((call) => call.verb))].sort(), ["click", "read", "type", "windows"]);
});
