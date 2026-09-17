/**
 * Integration review of mac6/bucket-23: the holes the adversarial pass found, each pinned by a test.
 * Fakes and plain objects only; nothing reaches the network or opens a window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { LiveSurfaces } from "../dist/asks/live-surfaces.js";
import { pullGithub, pullImap } from "../dist/asks/source-sync.js";
import { BranchNodes } from "../dist/asks/nodes.js";
import { cliCommands } from "../dist/cli-completion.js";
import { isReadOnlyPermission } from "../dist/policy.js";

const memoryStore = (modes) => {
  const saved = new Map(Object.entries(modes).map(([part, mode]) => [`asks-${part}`, { mode }]));
  return { get: (_t, _o, key) => (saved.has(key) ? { data: saved.get(key) } : undefined), save: (_t, _o, key, data) => saved.set(key, data) };
};

test("live pages: a failing tool is asked less and less often, not every beat forever", async () => {
  let now = 0, asked = 0, failing = true;
  const surfaces = new LiveSurfaces(memoryStore({ "live-surfaces": "on" }), "local", async () => {
    asked++;
    if (failing) throw new Error("Before I go ahead: needs a yes");
    return "fine";
  }, () => now);
  await surfaces.add({ title: "Build", tool: "demo.status", everySeconds: 30 });
  assert.equal(asked, 1);
  now = 31_000;
  assert.equal(await surfaces.tick(), 0, "after one failure the next ask waits twice as long");
  now = 61_000;
  assert.equal(await surfaces.tick(), 1);
  now = 61_000 + 61_000;
  assert.equal(await surfaces.tick(), 0, "after two failures it waits four times as long");
  now = 61_000 + 121_000;
  assert.equal(await surfaces.tick(), 1);
  failing = false;
  now += 241_000;
  assert.equal(await surfaces.tick(), 1);
  now += 31_000;
  assert.equal(await surfaces.tick(), 1, "a success puts it back on its own beat");
  assert.equal(asked, 5);
});

test("live pages: a slow beat is not stacked, and pressing refresh twice at once asks once", async () => {
  let now = 0, asked = 0, hold = false, release;
  const surfaces = new LiveSurfaces(memoryStore({ "live-surfaces": "on" }), "local", async () => {
    asked++;
    if (hold) await new Promise((resolve) => { release = resolve; });
    return "ok";
  }, () => now);
  const made = await surfaces.add({ title: "Queue", tool: "queue.list", everySeconds: 30 });
  now = 31_000;
  hold = true;
  const first = surfaces.tick();
  assert.equal(await surfaces.tick(), 0, "a beat that starts while one is running does nothing");
  hold = false;
  release();
  assert.equal(await first, 1);
  assert.equal(asked, 2);
  await surfaces.refresh(made.id, { manual: true });
  await surfaces.refresh(made.id, { manual: true });
  assert.equal(asked, 3, "the second press within ten seconds asks nothing");
  now += 11_000;
  await surfaces.refresh(made.id, { manual: true });
  assert.equal(asked, 4);
});

test("a mailbox source follows the owner's network rules before anything connects", async () => {
  let made = 0;
  const deps = {
    secret: async () => "pw",
    imap: () => { made++; return { connect: async () => {}, sinceUid: async () => [], close: async () => {} }; },
    assertHost: async (host, port) => { throw new Error(`${host}:${port} is on the blocked list`); },
  };
  await assert.rejects(pullImap(deps, { id: "m", kind: "imap", target: "me@x.com@imap.blocked.example:993", secret: "PW", limit: 5 }, ""),
    /imap\.blocked\.example:993 is on the blocked list/);
  assert.equal(made, 0, "no connection was opened");
});

test("a GitHub source names a real repository, not a path out of /repos", async () => {
  const deps = { fetch: async () => { throw new Error("should not be called"); }, secret: async () => "k" };
  for (const target of ["../..", "owner/..", "./x", "a/."])
    await assert.rejects(pullGithub(deps, { id: "g", kind: "github-issues", target, secret: "", limit: 5 }, ""), /owner\/repository/, target);
});

test("handing a task to another computer stops when the task is stopped", async () => {
  let calls = 0;
  const nodes = new BranchNodes(memoryStore({ nodes: "on" }), "local", async () => { calls++; return new Response("{}"); }, async () => "k");
  nodes.save({ nodes: [{ id: "desk", name: "Desk", address: "https://desk.example/", secret: "DESK" }] });
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(nodes.ask({ prompt: "x" }, stopped.signal), /stopped/i);
  assert.equal(calls, 0);
});

test("the Obsidian plugin only talks to Branch on this computer", () => {
  const source = createRequire(import.meta.url).resolve("../extras/obsidian-plugin/main.js");
  const module = { exports: {} };
  const code = `(function (require, module, exports) {${readFileSync(source, "utf8")}\n})`;
  vm.runInThisContext(code)(() => ({ Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, Setting: class {} }), module, module.exports);
  const { refusal } = module.exports.parts;
  const manifest = JSON.parse(readFileSync(new URL("../extras/obsidian-plugin/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.isDesktopOnly, true, "on a phone this computer is the phone, where Branch does not run");
  for (const address of ["http://127.0.0.1:3210", "http://localhost:3210", "http://[::1]:3210", "http://127.0.0.2:9"])
    assert.equal(refusal({ address, key: "k" }), null, address);
  for (const address of ["http://192.168.1.5:3210", "https://branch.example", "http://127.0.0.1.evil.example:3210", "http://localhost.evil.example"])
    assert.match(refusal({ address, key: "k" }), /this computer/, address);
});

test("branch app-server is offered by completion and help", () => {
  assert.ok(cliCommands.some((command) => command.name === "app-server"));
});

test("the policy hook only marks the looking tools as looking; every change stays a change", () => {
  for (const permission of ["projects.read", "intents.read", "sources.read", "blocks.read", "nodes.read"])
    assert.equal(isReadOnlyPermission(permission), true, permission);
  for (const permission of ["projects.manage", "sources.sync", "blocks.run", "nodes.run", "pages.write", "memory.write", "research.run"])
    assert.equal(isReadOnlyPermission(permission), false, permission);
});

test("Codex over app-server gets Branch's short environment and its own sign-in folder, no keys", async () => {
  const { codexEnvironment } = await import("../dist/asks/codex-app-server.js");
  const env = codexEnvironment({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", OPENAI_API_KEY: "sk-x", BRANCH_MASTER_KEY: "m", ANTHROPIC_API_KEY: "a" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex" });
});
