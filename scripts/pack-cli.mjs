#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Batch 20 (wave 8): makes the tarball an owner can install the `branch` command from.
 *
 * It runs `npm pack`, which only reads this folder and writes one file. It never publishes and it
 * never installs: putting the command on a computer is the owner's own step, and it is a step they
 * should take deliberately because it writes outside this folder.
 *
 *   node scripts/pack-cli.mjs [output folder]
 *   npm install -g ./branch-agent-<version>.tgz     <- the owner's step, not this script's
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? root);
mkdirSync(out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!manifest.bin?.branch) {
  console.error('package.json has no "bin": { "branch": ... }, so the packed file would install no command.');
  process.exit(1);
}

const result = spawnSync("npm", ["pack", "--pack-destination", out, "--loglevel", "error"], {
  cwd: root, encoding: "utf8", shell: process.platform === "win32",
});
if (result.status !== 0) {
  console.error(result.stderr || "npm pack failed");
  process.exit(result.status ?? 1);
}
const name = String(result.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
console.log(join(out, name ?? ""));
console.log(`\nInstall the command on this computer with:\n  npm install -g ${join(out, name ?? "")}\nThen: branch --help`);
