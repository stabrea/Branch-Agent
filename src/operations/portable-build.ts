import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentHostTarget, matchTarget, type PortableTarget } from "./portable-targets.js";

/**
 * FQ-operations.portable: a real single-file executable for the current, declared-supported
 * target, built with Node's own Single Executable Applications support (`node:sea`) plus
 * `postject` to inject the blob — both already vendored, free, local and offline. No bundler, no
 * signing service, no network call.
 *
 * The launcher is not a bundle of the whole program: Branch's CLI is dozens of ESM modules, and
 * turning that into one file is a bundler project of its own, out of scope here. Instead the SEA
 * blob is a small CommonJS bootstrap (the SEA entry point must be CJS) that dynamically imports the
 * real, already-built ESM program from a "dist" folder shipped next to the binary — the same way
 * the packed CLI tarball (scripts/pack-cli.mjs) ships dist/ alongside its entry point. What is
 * launched is a genuine native executable, not `node dist/cli.js`.
 */

/** Node's fixed sentinel for `NODE_SEA_FUSE_...`, the marker postject flips once injection succeeds. */
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export interface PortableBuildResult {
  ok: boolean;
  reason?: "unsupported_target" | "dist_missing" | "sea_config_failed" | "injection_failed";
  target?: PortableTarget;
  binaryPath?: string;
  distDir?: string;
  detail?: string;
}

function postjectCli(root: string): string {
  return join(root, "node_modules", "postject", "dist", "cli.js");
}

function bootstrapSource(): string {
  return `"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The packaged output always ships this binary beside the "dist" folder it boots (see
// buildPortableBinary in src/operations/portable-build.ts). BRANCH_PORTABLE_DIST overrides it only
// so a test can point a built binary at a scratch copy without rebuilding it.
const distDir = process.env.BRANCH_PORTABLE_DIST || path.join(path.dirname(process.execPath), "dist");
const entry = path.join(distDir, "cli.js");

import(pathToFileURL(entry).href).catch((error) => {
  console.error("Branch Agent portable launcher could not start: " + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
`;
}

/**
 * Builds the packaged binary into `outDir`. Refuses on a host that is not on the declared target
 * list, and refuses when `dist/` (the project's own `npm run build` output) is not there to ship —
 * either way the failure says which, rather than producing a binary that cannot start.
 */
export async function buildPortableBinary(options: {
  /** The project root: holds `dist/`, `node_modules/postject`, and `package.json`. */
  root: string;
  outDir: string;
  host?: { platform: NodeJS.Platform; arch: string };
}): Promise<PortableBuildResult> {
  const target = matchTarget(options.host ?? currentHostTarget());
  if (!target) return { ok: false, reason: "unsupported_target" };

  const distSource = join(options.root, "dist");
  if (!existsSync(join(distSource, "cli.js")))
    return { ok: false, reason: "dist_missing", target, detail: "dist/cli.js is not built. Run `npm run build` first." };

  await mkdir(options.outDir, { recursive: true });
  const bootstrapPath = join(options.outDir, "portable-bootstrap.cjs");
  const configPath = join(options.outDir, "portable-sea-config.json");
  const blobPath = join(options.outDir, "portable.blob");
  await writeFile(bootstrapPath, bootstrapSource(), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({ main: "portable-bootstrap.cjs", output: "portable.blob", disableExperimentalSEAWarning: true }, null, 2),
    "utf8",
  );

  const seaRun = spawnSync(process.execPath, ["--experimental-sea-config", configPath], { cwd: options.outDir, encoding: "utf8" });
  if (seaRun.status !== 0)
    return { ok: false, reason: "sea_config_failed", target, detail: (seaRun.stderr || seaRun.stdout || "").slice(0, 2000) };

  const binaryName = `branch-agent-portable${target.binaryExtension}`;
  const binaryPath = join(options.outDir, binaryName);
  await rm(binaryPath, { force: true });
  await copyFile(process.execPath, binaryPath);
  if (target.platform !== "win32") await chmod(binaryPath, 0o755);
  if (target.platform === "darwin")
    // Best-effort: the copied node binary keeps its old signature, which postject's own injection
    // already warns is now stale. Removing it is what lets the result run at all on that target;
    // failure here (codesign not installed) is not fatal, it only matters when built ON macOS.
    spawnSync("codesign", ["--remove-signature", binaryPath], { encoding: "utf8" });

  const inject = spawnSync(
    process.execPath,
    [postjectCli(options.root), binaryPath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE, "--overwrite"],
    { encoding: "utf8" },
  );
  if (inject.status !== 0)
    return { ok: false, reason: "injection_failed", target, detail: (inject.stderr || inject.stdout || "").slice(0, 2000) };

  const distDest = join(options.outDir, "dist");
  await rm(distDest, { recursive: true, force: true });
  await cp(distSource, distDest, { recursive: true });

  return { ok: true, target, binaryPath, distDir: distDest };
}

/** Total bytes of everything the build wrote — the "disk" half of the measured resource report. */
export async function packagedSizeBytes(outDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await stat(full)).size;
    }
  };
  await walk(outDir);
  return total;
}
