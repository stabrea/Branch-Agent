#!/usr/bin/env node
// bucket 22: the same installer on macOS and Linux (src/install/unix-install-cli.ts) and its own
// module on Windows (src/install/windows-install-cli.ts). This file only dispatches by platform, so
// either module's exported functions can be imported and tested without running an installer.
import { unixInstallMain } from "./unix-install-cli.js";
import { windowsInstallMain } from "./windows-install-cli.js";

/**
 * The installer's own small program. It runs from inside the unpacked download, using the runtime
 * that download already carries, so a person installs Branch without installing anything first.
 */
async function main(): Promise<void> {
  if (process.platform !== "win32") return unixInstallMain(process.argv.slice(2), process.env);
  return windowsInstallMain(process.argv.slice(2), process.env);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
