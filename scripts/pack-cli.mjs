#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
 *
 * mac7/packaging-real: `npm pack` packs whatever is on disk and says nothing about what is not.
 * Run without a build first, it happily wrote a one-megabyte tarball with no dist/ in it at all —
 * an installable file whose `branch` command points at a file that was never there. The phone
 * download is built from this script, and the Termux script's checksum matches a broken tarball
 * just as well as a good one, so nothing downstream would have noticed. Both ends are checked
 * here now: the built program has to be on disk before packing, and it has to be inside the
 * tarball afterwards.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The built files `npm pack` cannot produce, so they have to already be there. Paths from root. */
export function builtOutputs(manifest) {
  const bin = manifest.bin?.branch;
  return [...new Set([bin, "dist", "public"].filter(Boolean))];
}

/** Which of them are absent — empty means the folder is ready to be packed. */
export function missingOutputs(manifest, exists = (path) => existsSync(resolve(root, path))) {
  return builtOutputs(manifest).filter((path) => !exists(path));
}

/** The name the same file has inside the tarball, where every path sits under `package/`. */
export function pathInTarball(path) {
  return `package/${path}`;
}

function packedNames(tarball) {
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  return String(listed.stdout).split(/\r?\n/).map((line) => line.replace(/\/$/, "")).filter(Boolean);
}

function main(argv) {
  const out = resolve(argv[2] ?? root);
  mkdirSync(out, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!manifest.bin?.branch) {
    console.error('package.json has no "bin": { "branch": ... }, so the packed file would install no command.');
    return 1;
  }
  const missing = missingOutputs(manifest);
  if (missing.length) {
    console.error(`Nothing was packed: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not built yet.`);
    console.error("`npm pack` copies what is on disk, so packing now would write a tarball whose");
    console.error("`branch` command points at a file that is not in it. Run `npm run build` first.");
    return 1;
  }

  const result = spawnSync("npm", ["pack", "--pack-destination", out, "--loglevel", "error"], {
    cwd: root, encoding: "utf8", shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(result.stderr || "npm pack failed");
    return result.status ?? 1;
  }
  const name = String(result.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  const tarball = join(out, name ?? "");

  // `files` in package.json could drop the built program without this script changing at all, so
  // the tarball that was just written is read back rather than trusted.
  const names = packedNames(tarball);
  const wanted = pathInTarball(manifest.bin.branch);
  if (names && !names.includes(wanted)) {
    console.error(`${name} does not contain ${wanted}, so the command it installs would not run.`);
    console.error('Check "files" in package.json. The tarball was left in place to be looked at.');
    return 1;
  }

  console.log(tarball);
  console.log(`\nInstall the command on this computer with:\n  npm install -g ${tarball}\nThen: branch --help`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv));
