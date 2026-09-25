/**
 * The Dev update on Windows stopped at once, every time, after its first build: Electron reads an `.asar` file as a
 * folder, so the build's own `node_modules/electron/dist/resources/default_app.asar` could not be deleted (EBUSY),
 * and emptying the updater's folder failed before anything else ran. `removeTree` deletes it inside Electron too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { removeTree } from "../dist/desktop/remove-tree.js";

const require = createRequire(import.meta.url);
/** The Electron the desktop app is built with, and the real `.asar` archive it ships. */
function electron() {
  try {
    const binary = require("electron");
    const asar = join(require.resolve("electron"), "..", "dist", "resources", "default_app.asar");
    return typeof binary === "string" && existsSync(binary) && existsSync(asar) ? { binary, asar } : null;
  } catch { return null; }
}

async function treeWithAsar(asar) {
  const root = await mkdtemp(join(tmpdir(), "branch-remove-tree-"));
  const resources = join(root, "dev-source", "node_modules", "electron", "dist", "resources");
  await mkdir(resources, { recursive: true });
  if (asar) await copyFile(asar, join(resources, "default_app.asar"));
  else await writeFile(join(resources, "default_app.asar"), "not an archive");
  await writeFile(join(root, "dev-source", "package.json"), "{}");
  return join(root, "dev-source");
}

test("a folder is deleted with everything in it, in plain Node", async () => {
  const folder = await treeWithAsar(electron()?.asar);
  await removeTree(folder);
  assert.equal(existsSync(folder), false);
  await removeTree(folder); // a folder that is already gone is not an error
});

test("inside Electron, a build's .asar archive is deleted too, so the next Dev update can start", { skip: !electron() && "Electron is not installed here" }, async () => {
  const { binary, asar } = electron();
  const folder = await treeWithAsar(asar);
  const module = pathToFileURL(join(import.meta.dirname, "..", "dist", "desktop", "remove-tree.js")).href;
  const script = `import(${JSON.stringify(module)}).then((m) => m.removeTree(process.argv.at(-1))).then(() => console.log("removed"), (e) => console.log("failed " + e.code))`;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const said = await new Promise((resolve) => execFile(binary, ["-e", script, folder], { env, timeout: 60_000 }, (error, stdout) => resolve(String(stdout).trim() || String(error))));
  assert.equal(said, "removed");
  assert.equal(existsSync(folder), false, "nothing is left behind to stop the next build");
});
