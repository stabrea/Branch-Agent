import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { defaultShellConfig, locateProgram } from "../dist/integrations/default-shell.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { ToolRegistry } from "../dist/registry.js";

/**
 * Dogfood A2: with no command settings file the desktop app could not run a single command on its own computer,
 * so asked to fix its own code it could not look at it. It now starts with the developer programs installed here,
 * each by its full address; a program that is not installed is never listed.
 */

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-default-shell-"));
  t.after(() => discardTemp(root));
  return root;
}

test("on Windows the installed programs are listed by full address, and an npm launcher as Node running its script", async (t) => {
  const bin = await folder(t);
  await writeFile(join(bin, "git.exe"), "");
  await writeFile(join(bin, "node.exe"), "");
  await mkdir(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  await writeFile(join(bin, "npm.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n`);
  const config = defaultShellConfig({ PATH: bin, USERPROFILE: "C:\\Users\\owner" }, "win32");
  assert.deepEqual(config.executables.git, { path: join(bin, "git.exe"), args: [] });
  assert.deepEqual(config.executables.npm, { path: join(bin, "node.exe"), args: [join(bin, "node_modules", "npm", "bin", "npm-cli.js")] });
  assert.equal(config.executables.python, undefined, "a program that is not installed is never listed");
  assert.equal(config.env.HOME, "C:\\Users\\owner", "Git and npm find their settings from the home folder");
});

test("an npm launcher with no Node installed is not listed, and looking for Node itself ends", async (t) => {
  const bin = await folder(t);
  await mkdir(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  await writeFile(join(bin, "npm.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n`);
  assert.equal(locateProgram("npm", { PATH: bin }, "win32"), null);
  assert.equal(locateProgram("node", { PATH: bin }, "win32"), null);
});

test("elsewhere a program is found where PATH says, and nothing installed means no command settings at all", async (t) => {
  const bin = await folder(t);
  await writeFile(join(bin, "git"), "#!/bin/sh\n");
  await chmod(join(bin, "git"), 0o755);
  assert.deepEqual(locateProgram("git", { PATH: bin }, "linux"), { path: join(bin, "git"), args: [] });
  assert.equal(locateProgram("gh", { PATH: bin }, "linux"), null);
  assert.equal(defaultShellConfig({ PATH: await folder(t) }, "linux"), null);
});

test("with no settings file, Branch can still run the programs installed here", async (t) => {
  const registry = new ToolRegistry();
  const loaded = await loadIntegrations(registry, undefined, process.env);
  t.after(() => loaded.close());
  assert.ok(registry.names().includes("shell.execute"), "the command tool is there, because this computer has Node at least");
});
