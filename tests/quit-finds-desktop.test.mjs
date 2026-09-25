/**
 * Dogfood D1: `branch quit` in a plain terminal said "Branch Agent is not running." while the desktop app was running,
 * because without BRANCH_DATA_DIR it looked only in `.branch` under the folder it was typed in. It now also looks in
 * the desktop app's own folder. Everything is a stand-in: a note of a running app in a temporary folder, and a pretend
 * process that goes away when asked; nothing real is started or closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { desktopDataDirs, manageCommand } from "../dist/install/manage-cli.js";

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-quit-desktop-"));
  t.after(() => discardTemp(root));
  const env = { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local"), HOME: root };
  const desktop = join(env.APPDATA, "Branch Agent", "state");
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, "running.json"), JSON.stringify({ port: 4567, pid: 424242, url: "http://127.0.0.1:4567", mode: "app", version: "0.19.4", startedAt: new Date().toISOString() }));
  await writeFile(join(desktop, "session-token"), "a".repeat(64));
  let alive = true;
  const asked = [];
  const deps = { quit: {
    alive: (pid) => pid === 424242 && alive,
    fetch: async (url) => { asked.push(url); alive = false; return { ok: true }; },
    sleep: async () => {},
  } };
  return { root, env, desktop, deps, asked };
}

test("branch quit finds the desktop app's own folder when BRANCH_DATA_DIR is not set, and closes it", async (t) => {
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd)); // first, so the folder is left before it is taken away
  const { root, env, deps, asked } = await world(t);
  const said = [];
  process.chdir(root); // `.branch` under here holds nothing running
  const code = await manageCommand(["quit"], { env, platform: "win32", version: "0.19.4", packageRoot: root, print: (line) => said.push(line), deps });
  assert.equal(said.join("\n"), "Branch Agent has closed.");
  assert.equal(code, 0);
  assert.deepEqual(asked, ["http://127.0.0.1:4567/api/deployment/quit"]);
});

test("the desktop app's folder is where each kind of computer keeps it", () => {
  assert.deepEqual(desktopDataDirs({ APPDATA: "R", LOCALAPPDATA: "L" }, "win32"), [join("R", "Branch Agent", "state"), join("L", "Branch Agent", "state")]);
  assert.deepEqual(desktopDataDirs({ HOME: "H" }, "darwin"), [join("H", "Library", "Application Support", "Branch Agent", "state")]);
  assert.deepEqual(desktopDataDirs({ HOME: "H" }, "linux"), [join("H", ".config", "Branch Agent", "state")]);
  assert.deepEqual(desktopDataDirs({ HOME: "H", XDG_CONFIG_HOME: "X" }, "linux"), [join("X", "Branch Agent", "state")]);
});

test("with BRANCH_DATA_DIR set, only that folder is asked about", async (t) => {
  const { root, env, deps, asked } = await world(t);
  const said = [];
  const code = await manageCommand(["quit"], { env: { ...env, BRANCH_DATA_DIR: join(root, "elsewhere") }, platform: "win32", version: "0.19.4", packageRoot: root, print: (line) => said.push(line), deps });
  assert.equal(said.join("\n"), "Branch Agent is not running.");
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
});
